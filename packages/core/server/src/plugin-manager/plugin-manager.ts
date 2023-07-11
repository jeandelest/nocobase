import { CleanOptions, Collection, SyncOptions } from '@nocobase/database';
import fs from 'fs';
import net from 'net';
import path from 'path';
import xpipe from 'xpipe';
import Application from '../application';
import { Plugin } from '../plugin';
import collectionOptions from './options/collection';
import resourceOptions from './options/resource';
import { PluginManagerRepository } from './plugin-manager-repository';
import { pluginStatic } from './pluginStatic';
import { PluginData } from './types';
import {
  addByLocalPackage,
  addOrUpdatePluginByNpm,
  addOrUpdatePluginByZip,
  checkPluginPackage,
  getClientStaticUrl,
  getExtraPluginInfo,
  getNewVersion,
  getPackageJsonByLocalPath,
  getPluginPackagesPath,
  removePluginPackage,
} from './utils';

export interface PluginManagerOptions {
  app: Application;
  plugins?: (typeof Plugin | [typeof Plugin, any])[];
}

export interface InstallOptions {
  cliArgs?: any[];
  clean?: CleanOptions | boolean;
  sync?: SyncOptions;
}

export class PluginManager {
  app: Application;
  pmSock: string;
  server: net.Server;
  collection: Collection;
  initDatabasePluginsPromise: Promise<void>;
  repository: PluginManagerRepository;
  plugins = new Map<string | typeof Plugin, Plugin>();

  constructor(options: PluginManagerOptions) {
    this.app = options.app;
    this.app.db.registerRepositories({
      PluginManagerRepository,
    });

    this.initCommandCliSocket();
    this.collection = this.app.db.collection(collectionOptions);
    this.repository = this.collection.repository as PluginManagerRepository;
    this.repository.setPluginManager(this);
    this.app.resourcer.define(resourceOptions);

    this.app.acl.registerSnippet({
      name: 'pm',
      actions: ['pm:*'],
    });

    // plugin static files
    this.app.use(pluginStatic);

    // init static plugins
    this.initStaticPlugins(options.plugins);

    this.app.on('beforeLoad', async (app, options) => {
      if (options?.method && ['install', 'upgrade'].includes(options.method)) {
        await this.collection.sync();
      }

      const exists = await this.app.db.collectionExistsInDb('applicationPlugins');

      if (!exists) {
        this.app.log.warn(`applicationPlugins collection not exists in ${this.app.name}`);
        return;
      }

      if (options?.method !== 'install' || options.reload) {
        // await all database plugins init
        this.initDatabasePluginsPromise = this.initDatabasePlugins();

        // run all plugins' beforeLoad
        for await (const plugin of this.plugins.values()) {
          await plugin.beforeLoad();
        }
      }
    });

    this.app.on('beforeUpgrade', async () => {
      await this.collection.sync();
    });
  }

  initCommandCliSocket() {
    const f = path.resolve(process.cwd(), 'storage', 'pm.sock');
    this.pmSock = xpipe.eq(this.app.options.pmSock || f);
    this.app.db.registerRepositories({
      PluginManagerRepository,
    });
  }

  async initStaticPlugins(plugins: PluginManagerOptions['plugins'] = []) {
    for (const plugin of plugins) {
      if (Array.isArray(plugin)) {
        const [PluginClass, options] = plugin;
        this.setPluginInstance(PluginClass, options);
      } else {
        this.setPluginInstance(plugin, {});
      }
    }
  }

  async initDatabasePlugins() {
    const pluginList: PluginData[] = await this.repository.list(this.app.name);

    // TODO: 并发执行还是循序执行，现在的做法是顺序一个一个执行？
    for await (const pluginData of pluginList) {
      this.setDatabasePlugin(pluginData);
      await checkPluginPackage(pluginData);
    }
  }

  /**
   * get plugins static files
   *
   * @example
   * getPluginsClientFiles() =>
   *  {
   *    '@nocobase/acl': '/api/@nocobase/acl/index.js',
   *    'foo': '/api/foo/index.js'
   *  }
   */
  async getPluginsClientFiles(): Promise<Record<string, string>> {
    // await all plugins init
    await this.initDatabasePluginsPromise;

    const pluginList: PluginData[] = await this.repository.list(this.app.name, { enable: true, installed: true });
    return pluginList.reduce<Record<string, string>>((memo, item) => {
      const { name, clientUrl } = item;
      memo[name] = clientUrl;
      return memo;
    }, {});
  }

  async list() {
    const pluginData: PluginData[] = await this.repository.list(this.app.name);

    return Promise.all(
      pluginData.map(async (item) => {
        const extraInfo = await getExtraPluginInfo(item);
        return {
          ...item,
          ...extraInfo,
        };
      }),
    );
  }

  async setDatabasePlugin(pluginData: PluginData) {
    const PluginClass = require(pluginData.name);
    const pluginInstance = this.setPluginInstance(PluginClass, pluginData);
    return pluginInstance;
  }

  setPluginInstance(PluginClass: typeof Plugin, options: Pick<PluginData, 'name' | 'builtIn' | 'enabled'>) {
    const { name, enabled, builtIn } = options;

    if (typeof PluginClass !== 'function') {
      throw new Error(`plugin [${name}] must export a class`);
    }

    // 2. new plugin instance
    const instance: Plugin = new PluginClass(this.app, {
      name,
      enabled,
      builtIn,
    });

    // 3. add instance to plugins
    this.plugins.set(name || PluginClass, instance);

    return instance;
  }

  async addByNpm(data: any) {
    // 1. add plugin to database
    const { name, registry, builtIn, isOfficial } = data;

    if (this.plugins.has(name)) {
      throw new Error(`plugin name [${name}] already exists`);
    }

    const res = await this.repository.create({
      values: {
        name,
        registry,
        appName: this.app.name,
        zipUrl: undefined,
        clientUrl: undefined,
        version: undefined,
        enabled: false,
        isOfficial,
        installed: false,
        builtIn,
        options: {},
      },
    });

    // 2. download and unzip plugin
    const { version } = await addOrUpdatePluginByNpm({ name, registry });

    // 3. update database
    await this.repository.update({
      filter: { name, appName: this.app.name },
      values: {
        version,
        clientUrl: getClientStaticUrl(name),
        installed: true,
      },
    });

    // 4.run plugin
    const instance = await this.setDatabasePlugin({ name, enabled: false, builtIn });

    await instance.afterAdd();

    return res;
  }

  async upgradeByNpm(name: string) {
    const pluginData = await this.getPluginData(name);

    // 1. download and unzip package
    const latestVersion = await getNewVersion(pluginData);
    if (latestVersion) {
      await addOrUpdatePluginByNpm({ name, registry: pluginData.registry, version: latestVersion });
    }

    // 2. update database
    await this.repository.update({
      filter: { name, appName: this.app.name },
      values: {
        version: latestVersion,
      },
    });

    // 3. run plugin
    const instance = await this.setDatabasePlugin(pluginData);

    // TODO: 升级后应该执行哪些 hooks？
    // 这里执行了 `afterAdd` 和 `load`
    await instance.afterAdd();

    if (pluginData.enabled) {
      await instance.load();
    }
  }

  async upgradeByZip(name: string, zipUrl: string) {
    // 1. download and unzip package
    const { version } = await addOrUpdatePluginByZip({ name, zipUrl });

    // 2. update database
    const pluginData = await this.repository.update({
      filter: { name, appName: this.app.name },
      values: {
        version,
      },
    });

    // 3. run plugin
    const instance = await this.setDatabasePlugin(pluginData);

    // TODO: 升级后应该执行哪些 hooks？
    // 这里执行了 `afterAdd` 和 `load`
    await instance.afterAdd();

    if (pluginData.enabled) {
      await instance.load();
    }
  }

  async addByUpload(data: { zipUrl: string; builtIn?: boolean; isOfficial?: boolean }) {
    // download and unzip plugin
    const { packageDir } = await addOrUpdatePluginByZip({ zipUrl: data.zipUrl });

    return this.addByLocalPath(packageDir, data);
  }

  async addByLocalPath(localPath: string, data: { zipUrl?: string; builtIn?: boolean; isOfficial?: boolean } = {}) {
    const { zipUrl, builtIn = false, isOfficial = false } = data;
    const { name, version } = getPackageJsonByLocalPath(localPath);
    if (this.plugins.has(name)) {
      throw new Error(`plugin [${name}] already exists`);
    }

    // 1. add plugin to database
    const res = await this.repository.create({
      values: {
        name,
        appName: this.app.name,
        zipUrl,
        builtIn,
        isOfficial,
        clientUrl: getClientStaticUrl(name),
        version,
        registry: undefined,
        enabled: false,
        installed: true,
        options: {},
      },
    });

    // 2. set plugin instance
    const instance = await this.setDatabasePlugin({ name, enabled: false, builtIn });

    // 3. run `afterAdd` hook
    await instance.afterAdd();

    return res;
  }

  async enable(name: string) {
    const pluginInstance = this.getPluginInstance(name);

    // 1. check required plugins
    const requiredPlugins = pluginInstance.requiredPlugins();
    for (const requiredPluginName of requiredPlugins) {
      const requiredPlugin = this.plugins.get(requiredPluginName);
      if (!requiredPlugin.enabled) {
        throw new Error(`${name} plugin need ${requiredPluginName} plugin enabled`);
      }
    }

    // 2. update database
    await this.repository.update({
      filter: {
        name,
        appName: this.app.name,
      },
      values: {
        enabled: true,
      },
    });

    // 3. run `install` hook
    await pluginInstance.install();

    // 4. run `afterEnable` hook
    await pluginInstance.afterEnable();

    // 5. emit app hook
    await this.app.emitAsync('afterEnablePlugin', name);

    // 6. load plugin
    await this.load(pluginInstance);
  }

  async disable(name: string) {
    const pluginInstance = this.getPluginInstance(name);

    if (pluginInstance.builtIn) {
      throw new Error(`${name} plugin is builtIn, can not disable`);
    }

    // 1. update database
    await this.repository.update({
      filter: {
        name,
        builtIn: false,
        appName: this.app.name,
      },
      values: {
        enabled: false,
      },
    });

    // 2. run `afterDisable` hook
    await pluginInstance.afterDisable();

    // 3. emit app hook
    await this.app.emitAsync('afterDisablePlugin', name);
  }

  async remove(name: string) {
    const pluginInstance = this.getPluginInstance(name);

    if (pluginInstance.builtIn) {
      throw new Error(`${name} plugin is builtIn, can not remove`);
    }

    // 1. run `remove` hook
    await pluginInstance.remove();

    // 2. remove plugin from database
    await this.repository.destroy({
      filter: {
        name,
        builtIn: false,
        appName: this.app.name,
      },
    });

    // 3. remove instance
    this.plugins.delete(name);

    // 4. remove plugin package
    await removePluginPackage(name);
  }

  async loadAll(options: any) {
    // TODO: 是否改为并行加载？
    for await (const pluginInstance of this.plugins.values()) {
      await this.load(pluginInstance, options);
    }
  }

  async load(pluginInstance: Plugin, options: any = {}) {
    if (!pluginInstance.enabled) return;

    await this.app.emitAsync('beforeLoadPlugin', pluginInstance, options);
    await pluginInstance.load();
    await this.app.emitAsync('afterLoadPlugin', pluginInstance, options);
  }

  async getPluginData(name: string) {
    const pluginData: PluginData = await this.repository.findOne({
      filter: { name, appName: this.app.name },
    });

    if (!pluginData) {
      throw new Error(`plugin [${name}] not exists`);
    }

    return pluginData;
  }

  getPluginInstance(name: string) {
    const pluginInstance: Plugin = this.plugins.get(name);
    if (!pluginInstance) {
      throw new Error(`${name} plugin does not exist`);
    }

    return pluginInstance;
  }

  clone() {
    const pm = new PluginManager({
      app: this.app,
    });
    return pm;
  }

  async install(options: InstallOptions = {}) {
    for (const [name, plugin] of this.plugins) {
      if (!plugin.enabled) {
        continue;
      }
      await this.app.emitAsync('beforeInstallPlugin', plugin, options);
      await plugin.install(options);
      await this.app.emitAsync('afterInstallPlugin', plugin, options);
    }
  }

  // by cli: `yarn nocobase pm create xxx`
  async createByCli(name: string) {
    console.log(`creating ${name} plugin...`);
    const { run } = require('@nocobase/cli/src/util');
    const { PluginGenerator } = require('@nocobase/cli/src/plugin-generator');
    const generator = new PluginGenerator({
      cwd: getPluginPackagesPath(),
      args: {},
      context: {
        name,
      },
    });
    await generator.run();
    await run('yarn', ['install']);
  }

  // by cli: `yarn nocobase pm add xxx`
  async addByCli(name: string) {
    console.log(`adding ${name} plugin...`);
    const localPackage = path.join(getPluginPackagesPath(), name);
    if (!fs.existsSync(localPackage)) {
      throw new Error(`plugin [${name}] not exists, Please use 'yarn nocobase pm create ${name}' to create first.`);
    }

    await addByLocalPackage(localPackage);

    return this.addByLocalPath(localPackage);
  }

  // by cli: `yarn nocobase pm remove xxx`
  get removeByCli() {
    return this.remove;
  }

  // by cli: `yarn nocobase pm enable xxx`
  get enableByCli() {
    return this.enable;
  }

  // by cli: `yarn nocobase pm disable xxx`
  get disableByCli() {
    return this.disable;
  }

  doCliCommand(method: string, name: string | string[]) {
    const pluginNames = Array.isArray(name) ? name : [name];
    return Promise.all(pluginNames.map((name) => this[`${method}ByCli`](name)));
  }

  // for cli: `yarn nocobase pm create/add/enable/disable/remove xxx`
  async clientWrite(data: { method: string; plugins: string | string[] }) {
    const { method, plugins } = data;
    if (method === 'create') {
      try {
        console.log(method, plugins);
        await this.doCliCommand(method, plugins);
      } catch (error) {
        console.error(error.message);
      }
      return;
    }
    const client = new net.Socket();
    client.connect(this.pmSock, () => {
      client.write(JSON.stringify(data));
      client.end();
    });
    client.on('error', async () => {
      try {
        console.log(method, plugins);
        await this.doCliCommand(method, plugins);
      } catch (error) {
        console.error(error.message);
      }
    });
  }

  async listen(): Promise<net.Server> {
    this.server = net.createServer((socket) => {
      socket.on('data', async (data) => {
        const { method, plugins } = JSON.parse(data.toString());
        try {
          console.log(method, plugins);
          await this.doCliCommand(method, plugins);
        } catch (error) {
          console.error(error.message);
        }
      });
      socket.pipe(socket);
    });

    if (fs.existsSync(this.pmSock)) {
      await fs.promises.unlink(this.pmSock);
    }
    return new Promise((resolve) => {
      this.server.listen(this.pmSock, () => {
        resolve(this.server);
      });
    });
  }
}

export default PluginManager;
