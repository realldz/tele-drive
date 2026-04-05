'use client';

import { useCallback, useEffect } from 'react';
import type { AdminSetting } from '@/lib/types';

const BYTE_SETTING_KEYS = ['DEFAULT_USER_QUOTA', 'DEFAULT_GUEST_BANDWIDTH', 'DEFAULT_DAILY_BANDWIDTH_LIMIT'];
const SECONDS_SETTING_KEYS = ['DOWNLOAD_URL_TTL_SECONDS', 'STREAM_COOKIE_TTL_SECONDS'];

interface SettingValueProps {
  setting: AdminSetting;
  editingValue: string | undefined;
  t: (key: string, params?: Record<string, string | number>) => string;
  formatBytes: (bytes: string | number) => string;
  onSettingChange: (key: string, value: string) => void;
  onUpdateSetting: (key: string, value: string) => void;
}

function getSettingHint(key: string, value: string, formatBytes: (b: string | number) => string, t: (key: string) => string): string {
  if (BYTE_SETTING_KEYS.includes(key)) return formatBytes(value);
  if (SECONDS_SETTING_KEYS.includes(key)) return `${value}s`;
  if (key === 'ENABLE_MULTI_THREAD_DOWNLOAD') return value === 'true' ? t('admin.enabled') : t('admin.disabled');
  return value;
}

function SettingInput({ setting, editingValue, t, formatBytes, onSettingChange, onUpdateSetting }: SettingValueProps) {
  const currentValue = editingValue ?? setting.value;
  const isChanged = editingValue !== undefined && editingValue !== setting.value;

  const handleUpdate = useCallback(() => {
    onUpdateSetting(setting.key, currentValue);
  }, [setting.key, currentValue, onUpdateSetting]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onSettingChange(setting.key, e.target.value);
  }, [setting.key, onSettingChange]);

  const hint = getSettingHint(setting.key, currentValue, formatBytes, t);

  return (
    <>
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={currentValue}
          onChange={handleChange}
          className="flex-1 w-full border border-gray-300 rounded-lg px-3 py-1.5 focus:ring focus:ring-blue-100 outline-none text-sm"
          aria-label={`Setting ${setting.key}`}
        />
        <span className="text-xs text-gray-400 w-24 text-right flex-shrink-0">{hint}</span>
      </div>
      <button
        onClick={handleUpdate}
        disabled={!isChanged}
        className="px-3 py-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:bg-gray-100 disabled:text-gray-400 rounded-md text-sm font-medium transition-colors"
      >
        {t('admin.update')}
      </button>
    </>
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
  settings, editingSettings, t, formatBytes,
  onSettingChange, onUpdateSetting,
}: SystemSettingsProps) {
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
      <div className="max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold mb-6 text-gray-800">{t('admin.settingsTitle')}</h2>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center text-gray-500">
          {t('admin.loadingSettings')}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold mb-6 text-gray-800">{t('admin.settingsTitle')}</h2>

      {/* Desktop table */}
      <div className="hidden md:block bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-gray-50 text-gray-600 text-sm">
              <th className="p-4 font-medium border-b">{t('admin.key')}</th>
              <th className="p-4 font-medium border-b">{t('admin.value')}</th>
              <th className="p-4 font-medium border-b text-right">{t('admin.action')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {settings.map((setting) => (
              <tr key={setting.key} className="hover:bg-gray-50">
                <td className="p-4 font-mono text-sm text-gray-800">{setting.key}</td>
                <td className="p-4">
                  <div className="flex items-center gap-3">
                    <input
                      type="text"
                      value={editingSettings[setting.key] ?? setting.value}
                      onChange={(e) => onSettingChange(setting.key, e.target.value)}
                      className="flex-1 w-full border border-gray-300 rounded-lg px-3 py-1.5 focus:ring focus:ring-blue-100 outline-none text-sm"
                      aria-label={`Setting ${setting.key}`}
                    />
                    <span className="text-xs text-gray-400 w-24 text-right flex-shrink-0">
                      {getSettingHint(setting.key, editingSettings[setting.key] ?? setting.value, formatBytes, t)}
                    </span>
                  </div>
                </td>
                <td className="p-4 text-right whitespace-nowrap">
                  <button
                    onClick={() => onUpdateSetting(setting.key, editingSettings[setting.key] ?? setting.value)}
                    disabled={editingSettings[setting.key] === setting.value}
                    className="px-3 py-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:bg-gray-100 disabled:text-gray-400 rounded-md text-sm font-medium transition-colors"
                  >
                    {t('admin.update')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-4">
        {settings.map((setting) => (
          <div key={setting.key} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
            <SettingInput
              setting={setting}
              editingValue={editingSettings[setting.key]}
              t={t}
              formatBytes={formatBytes}
              onSettingChange={onSettingChange}
              onUpdateSetting={onUpdateSetting}
            />
          </div>
        ))}
      </div>
    </div>
  );
}