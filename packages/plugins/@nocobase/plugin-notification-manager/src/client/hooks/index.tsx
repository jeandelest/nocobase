/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { createContext, useContext, useMemo } from 'react';
import {
  ActionProps,
  ISchema,
  useActionContext,
  useCollection,
  useCollectionRecord,
  useCollectionRecordData,
  useDataBlockRequest,
  useDataBlockResource,
} from '@nocobase/client';
import { App as AntdApp } from 'antd';
import { createForm } from '@formily/core';
import { useForm } from '@formily/react';

export const useSubmitActionProps = () => {
  const { setVisible } = useActionContext();
  const { message } = AntdApp.useApp();
  const form = useForm();
  const resource = useDataBlockResource();
  const { runAsync } = useDataBlockRequest();
  const collection = useCollection();
  return {
    type: 'primary',
    async onClick() {
      await form.submit();
      const values = form.values;
      if (values[collection.filterTargetKey]) {
        await resource.update({
          values,
          filterByTk: values[collection.filterTargetKey],
        });
      } else {
        await resource.create({
          values,
        });
      }
      await runAsync();
      message.success('Saved successfully!');
      setVisible(false);
    },
  };
};

export const useEditFormProps = () => {
  const recordData = useCollectionRecordData();
  const form = useMemo(
    () =>
      createForm({
        initialValues: recordData,
      }),
    [],
  );

  return {
    form,
  };
};

export function useDeleteActionProps(): ActionProps {
  const { message } = AntdApp.useApp();
  const record = useCollectionRecordData();
  const resource = useDataBlockResource();
  const { runAsync } = useDataBlockRequest();
  const collection = useCollection();
  return {
    confirm: {
      title: 'Delete',
      content: 'Are you sure you want to delete it?',
    },
    async onClick() {
      await resource.destroy({
        filterByTk: record[collection.filterTargetKey],
      });
      await runAsync();
      message.success('Deleted!');
    },
  };
}

export const NotificationVariableContext = createContext([]);

export const useNotificationVariableOptions = () => {
  const scope = useContext(NotificationVariableContext);
  return { scope };
};

export const NotificationVariableProvider = ({ value, children }) => {
  return <NotificationVariableContext.Provider value={value}>{children}</NotificationVariableContext.Provider>;
};

export * from './channel';
