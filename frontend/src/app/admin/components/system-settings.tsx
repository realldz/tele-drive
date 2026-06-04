'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminSetting } from '@/lib/types';
import { Database, Activity, Server, Cloud, Info, Check } from 'lucide-react';

const BYTE_SETTING_KEYS = [
  'DEFAULT_USER_QUOTA',
  'DEFAULT_GUEST_BANDWIDTH',
  'DEFAULT_DAILY_BANDWIDTH_LIMIT',
  'MAX_BUFFER_FILE_SIZE',
  'MAX_BATCH_TOTAL_SIZE',
];
const SECONDS_SETTING_KEYS = ['DOWNLOAD_URL_TTL_SECONDS', 'STREAM_COOKIE_TTL_SECONDS'];

interface SettingValueProps {
  setting: AdminSetting;
  editingValue: string | undefined;
  t: (key: string, params?: Record<string, string | number>) => string;
  formatBytes: (bytes: string | number) => string;
  onSettingChange: (key: string, value: string) => void;
  onUpdateSetting: (key: string, value: string) => void;
}

function getSettingHint(
  key: string,
  value: string,
  formatBytes: (b: string | number) => string,
  t: (key: string) => string
): string {
  if (BYTE_SETTING_KEYS.includes(key)) return formatBytes(value);
  if (SECONDS_SETTING_KEYS.includes(key)) return `${value}s`;
  if (key === 'ENABLE_MULTI_THREAD_DOWNLOAD') return value === 'true' ? t('admin.enabled') : t('admin.disabled');
  if (key === 'MAX_BUFFER_DISK_MB') return `${value} MB`;
  if (key === 'BUFFER_TTL_HOURS') return `${value}h`;
  if (key === 'BUFFER_MAX_RETRIES') return `${value} retries`;
  return value;
}

const TABS = [
  { id: 'storage', icon: Database, label: 'admin.tabStorage' },
  { id: 'bandwidth', icon: Activity, label: 'admin.tabBandwidth' },
  { id: 'buffer', icon: Server, label: 'admin.tabBuffer' },
  { id: 's3', icon: Cloud, label: 'admin.tabS3' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const KEY_TO_GROUP: Record<string, TabId> = {
  DEFAULT_USER_QUOTA: 'storage',
  MAX_CONCURRENT_CHUNKS: 'storage',
  DOWNLOAD_URL_TTL_SECONDS: 'storage',
  STREAM_COOKIE_TTL_SECONDS: 'storage',

  DEFAULT_GUEST_BANDWIDTH: 'bandwidth',
  DEFAULT_FILE_DOWNLOAD_LIMIT: 'bandwidth',
  DEFAULT_DAILY_BANDWIDTH_LIMIT: 'bandwidth',
  ENABLE_MULTI_THREAD_DOWNLOAD: 'bandwidth',

  MAX_BUFFER_FILE_SIZE: 'buffer',
  MAX_BUFFER_DISK_MB: 'buffer',
  MAX_BATCH_SIZE: 'buffer',
  MAX_BATCH_TOTAL_SIZE: 'buffer',
  BUFFER_TTL_HOURS: 'buffer',
  BUFFER_MAX_RETRIES: 'buffer',

  S3_PUBLIC_ACCESS_ENABLED: 's3',
};

const getSettingGroup = (key: string): TabId => KEY_TO_GROUP[key] || 'storage';

function SettingCard({
  setting,
  editingValue,
  t,
  formatBytes,
  onSettingChange,
  onUpdateSetting,
}: SettingValueProps) {
  const currentValue = editingValue ?? setting.value;
  const isChanged = editingValue !== undefined && editingValue !== setting.value;

  const handleUpdate = useCallback(() => {
    onUpdateSetting(setting.key, currentValue);
  }, [setting.key, currentValue, onUpdateSetting]);

  const handleChange = useCallback((val: string) => {
    onSettingChange(setting.key, val);
  }, [setting.key, onSettingChange]);

  const hint = getSettingHint(setting.key, currentValue, formatBytes, t);

  const isBoolean = setting.key === 'ENABLE_MULTI_THREAD_DOWNLOAD' || setting.key === 'S3_PUBLIC_ACCESS_ENABLED';

  const titleKey = `settings.${setting.key}.title`;
  const descKey = `settings.${setting.key}.description`;
  const title = t(titleKey) === titleKey ? setting.key : t(titleKey);
  const desc = t(descKey) === descKey ? '' : t(descKey);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 flex flex-col justify-between gap-4 transition-all duration-200 hover:shadow-md">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-gray-800 text-sm md:text-base leading-tight">
            {title}
          </h3>
          <span className="font-mono text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded flex-shrink-0">
            {setting.key}
          </span>
        </div>
        {desc && (
          <p className="text-xs text-gray-500 leading-normal flex items-start gap-1">
            <Info className="w-3.5 h-3.5 mt-0.5 text-gray-400 flex-shrink-0" />
            <span>{desc}</span>
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          {isBoolean ? (
            <select
              value={currentValue}
              onChange={(e) => handleChange(e.target.value)}
              className="flex-1 w-full border border-gray-300 rounded-lg px-3 py-1.5 focus:ring focus:ring-blue-100 focus:border-blue-500 outline-none text-sm bg-white"
            >
              <option value="true">{t('admin.enabled')}</option>
              <option value="false">{t('admin.disabled')}</option>
            </select>
          ) : (
            <input
              type="text"
              value={currentValue}
              onChange={(e) => handleChange(e.target.value)}
              className="flex-1 w-full border border-gray-300 rounded-lg px-3 py-1.5 focus:ring focus:ring-blue-100 focus:border-blue-500 outline-none text-sm font-mono"
              aria-label={`Setting ${setting.key}`}
            />
          )}
          {hint && (
            <span className="text-xs font-semibold text-gray-400 bg-gray-50 px-2 py-1 rounded border border-gray-100 text-right flex-shrink-0 min-w-[5rem]">
              {hint}
            </span>
          )}
        </div>
      </div>

      <div className="flex justify-end pt-1">
        <button
          onClick={handleUpdate}
          disabled={!isChanged}
          className="flex items-center justify-center gap-1.5 px-4 py-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:bg-gray-100 disabled:text-gray-400 rounded-lg text-xs font-semibold transition-all shadow-sm active:scale-95"
        >
          <Check className="w-3.5 h-3.5" />
          {t('admin.update')}
        </button>
      </div>
    </div>
  );
}

interface SystemSettingsProps {
  settings: AdminSetting[];
  editingSettings: Record<string, string>;
  t: (key: string, params?: Record<string, string | number>) => string;
  formatBytes: (bytes: string | number) => string;
  onSettingChange: (key: string, value: string) => void;
  onUpdateSetting: (key: string, value: string) => void;
}

export default function SystemSettings({
  settings,
  editingSettings,
  t,
  formatBytes,
  onSettingChange,
  onUpdateSetting,
}: SystemSettingsProps) {
  const [activeTab, setActiveTab] = useState<TabId>('storage');

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        (document.activeElement as HTMLElement)?.blur();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (settings.length === 0) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h2 className="text-2xl font-bold mb-6 text-gray-800">{t('admin.settingsTitle')}</h2>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center text-gray-500">
          {t('admin.loadingSettings')}
        </div>
      </div>
    );
  }

  const filteredSettings = settings.filter((s) => getSettingGroup(s.key) === activeTab);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex flex-col gap-1 mb-6">
        <h2 className="text-2xl font-bold text-gray-900 leading-tight">
          {t('admin.settingsTitle')}
        </h2>
        <p className="text-sm text-gray-500">
          {t('admin.dashboardDescription')}
        </p>
      </div>

      <div className="flex border-b border-gray-200 overflow-x-auto no-scrollbar mb-6">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-5 py-3 border-b-2 font-medium text-sm transition-all whitespace-nowrap outline-none ${
                isActive
                  ? 'border-blue-600 text-blue-600 font-semibold'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <Icon className="w-4 h-4" />
              {t(tab.label)}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {filteredSettings.map((setting) => (
          <SettingCard
            key={setting.key}
            setting={setting}
            editingValue={editingSettings[setting.key]}
            t={t}
            formatBytes={formatBytes}
            onSettingChange={onSettingChange}
            onUpdateSetting={onUpdateSetting}
          />
        ))}
      </div>
    </div>
  );
}