'use client';

import { useState } from 'react';

const BYTE_SETTING_KEYS = ['DEFAULT_USER_QUOTA', 'DEFAULT_GUEST_BANDWIDTH', 'DEFAULT_DAILY_BANDWIDTH_LIMIT'];
const SECONDS_SETTING_KEYS = ['DOWNLOAD_URL_TTL_SECONDS', 'STREAM_COOKIE_TTL_SECONDS'];

interface Setting {
  key: string;
  value: string;
}

interface SystemSettingsProps {
  settings: Setting[];
  editingSettings: Record<string, string>;
  t: (key: string, params?: Record<string, string | number>) => string;
  formatBytes: (bytes: string | number) => string;
  onSettingChange: (key: string, value: string) => void;
  onUpdateSetting: (key: string, value: string) => void;
}

function getSettingHint(key: string, value: string, formatBytes: (b: string | number) => string): string {
  if (BYTE_SETTING_KEYS.includes(key)) return formatBytes(value);
  if (SECONDS_SETTING_KEYS.includes(key)) return `${value}s`;
  if (key === 'ENABLE_MULTI_THREAD_DOWNLOAD') return value === 'true' ? 'Enabled' : 'Disabled';
  return value;
}

export default function SystemSettings({
  settings, editingSettings, t, formatBytes,
  onSettingChange, onUpdateSetting,
}: SystemSettingsProps) {
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
                    />
                    <span className="text-xs text-gray-400 w-24 text-right flex-shrink-0">
                      {getSettingHint(setting.key, editingSettings[setting.key] ?? setting.value, formatBytes)}
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
            {settings.length === 0 && (
              <tr><td colSpan={3} className="p-4 text-center text-gray-500">{t('admin.loadingSettings')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-4">
        {settings.map((setting) => (
          <div key={setting.key} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
            <p className="font-mono text-sm text-gray-800 font-medium mb-2 break-all">{setting.key}</p>
            <input
              type="text"
              value={editingSettings[setting.key] ?? setting.value}
              onChange={(e) => onSettingChange(setting.key, e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none text-sm mb-2"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">
                {getSettingHint(setting.key, editingSettings[setting.key] ?? setting.value, formatBytes)}
              </span>
              <button
                onClick={() => onUpdateSetting(setting.key, editingSettings[setting.key] ?? setting.value)}
                disabled={editingSettings[setting.key] === setting.value}
                className="px-3 py-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:bg-gray-100 disabled:text-gray-400 rounded-md text-sm font-medium transition-colors"
              >
                {t('admin.update')}
              </button>
            </div>
          </div>
        ))}
        {settings.length === 0 && (
          <div className="p-4 text-center text-gray-500">{t('admin.loadingSettings')}</div>
        )}
      </div>
    </div>
  );
}
