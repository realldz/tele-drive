'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { fetchSettings as fetchSettingsApi, formatBytes, getApiErrorMessage, updateSetting } from '@/lib/api';
import type { AdminSetting } from '@/lib/types';
import { useI18n } from '@/components/i18n-context';
import SystemSettings from '../components/system-settings';

export default function AdminSettingsPage() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<AdminSetting[]>([]);
  const [editingSettings, setEditingSettings] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchSettingsApi()
      .then((data) => {
        setSettings(data);
        const initial: Record<string, string> = {};
        data.forEach((s) => {
          initial[s.key] = s.value;
        });
        setEditingSettings(initial);
      })
      .catch((err: unknown) => {
        toast.error(getApiErrorMessage(err, t('admin.fetchSettingsError')));
      });
  }, [t]);

  return (
    <SystemSettings
      settings={settings}
      editingSettings={editingSettings}
      t={t}
      formatBytes={formatBytes}
      onSettingChange={(key, value) =>
        setEditingSettings((prev) => ({ ...prev, [key]: value }))
      }
      onUpdateSetting={async (key, value) => {
        try {
          await updateSetting(key, value);
          toast.success(t('admin.updateSettingSuccess'));
          const data = await fetchSettingsApi();
          setSettings(data);
          const initial: Record<string, string> = {};
          data.forEach((s) => {
            initial[s.key] = s.value;
          });
          setEditingSettings(initial);
        } catch (err: unknown) {
          toast.error(getApiErrorMessage(err, t('admin.updateSettingError')));
        }
      }}
    />
  );
}
