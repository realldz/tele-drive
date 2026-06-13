'use client';

import { Fragment, useState } from 'react';
import { Info, Loader2, Save, Settings2, Trash2 } from 'lucide-react';
import { LOCALE_DATE_MAP } from '@/providers/i18n-context';
import { formatBytes } from '@/lib/api';
import { getFileIcon } from '@/lib/file-icon';
import type { AdminUserFile } from '@/lib/types';

export interface DownloadPolicyForm {
  downloadLimit24h: string;
  bandwidthLimitGB: string;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface AdminUserFileRowProps {
  file: AdminUserFile;
  locale: string;
  t: Translate;
  actionLoading: Set<string>;
  onShowDetail: (file: AdminUserFile) => void;
  onDeleteFile: (fileId: string) => void;
  onSavePolicy: (fileId: string, form: DownloadPolicyForm) => Promise<void>;
}

export default function AdminUserFileRow({
  file, locale, t, actionLoading, onShowDetail, onDeleteFile, onSavePolicy,
}: AdminUserFileRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [policyForm, setPolicyForm] = useState<DownloadPolicyForm>({ downloadLimit24h: '', bandwidthLimitGB: '' });

  const isSaving = actionLoading.has(`policy:${file.id}`);
  const isDeleting = actionLoading.has(`delete:${file.id}`);

  const startEdit = () => {
    setPolicyForm({
      downloadLimit24h: file.downloadLimit24h === null ? '' : String(file.downloadLimit24h),
      bandwidthLimitGB: file.bandwidthLimit24h === null ? '' : (Number(file.bandwidthLimit24h) / 1024 ** 3).toString(),
    });
    setIsEditing(true);
  };

  return (
    <Fragment>
      <tr className="hover:bg-gray-50">
        <td className="p-4 font-medium text-gray-800">
          <div className="flex items-center gap-2">
            {getFileIcon(file.mimeType, 'w-5 h-5')}
            <span className="truncate max-w-[260px]">{file.filename}</span>
            {file.isEncrypted && (
              <span className="bg-green-100 text-green-700 text-[10px] px-1.5 py-0.5 rounded uppercase font-bold">
                {t('admin.encrypted')}
              </span>
            )}
          </div>
        </td>
        <td className="p-4 text-sm text-gray-600">{formatBytes(file.size)}</td>
        <td className="p-4 text-sm text-gray-600">
          {file.downloads24h} / {file.downloadLimit24h ?? t('admin.noLimit')}
        </td>
        <td className="p-4 text-sm text-gray-600">
          {formatBytes(file.bandwidthUsed24h)} / {file.bandwidthLimit24h === null ? t('admin.noLimit') : formatBytes(file.bandwidthLimit24h)}
        </td>
        <td className="p-4 text-sm text-gray-500">
          {new Date(file.lastDownloadReset).toLocaleString(LOCALE_DATE_MAP[locale as keyof typeof LOCALE_DATE_MAP] || 'en-US')}
        </td>
        <td className="p-4 text-right whitespace-nowrap space-x-1">
          <button onClick={() => onShowDetail(file)} className="p-2 text-blue-500 hover:bg-blue-50 rounded-lg transition-colors inline-block" title={t('admin.fileDetails')}>
            <Info size={18} />
          </button>
          <button onClick={startEdit} className="p-2 text-amber-500 hover:bg-amber-50 rounded-lg transition-colors inline-block" title={t('admin.editDownloadPolicy')}>
            <Settings2 size={18} />
          </button>
          <button
            onClick={() => onDeleteFile(file.id)}
            disabled={isDeleting}
            className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors inline-block disabled:opacity-50"
            title={t('admin.deletePermanent')}
          >
            {isDeleting ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
          </button>
        </td>
      </tr>

      {isEditing && (
        <tr>
          <td colSpan={6} className="p-4 bg-amber-50 border-t border-amber-100">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('admin.downloadLimit24h')}</label>
                <input
                  type="number" min="0"
                  value={policyForm.downloadLimit24h}
                  onChange={(e) => setPolicyForm((prev) => ({ ...prev, downloadLimit24h: e.target.value }))}
                  placeholder={t('admin.noLimit')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('admin.bandwidthLimit24hFile')}</label>
                <input
                  type="number" min="0" step="0.1"
                  value={policyForm.bandwidthLimitGB}
                  onChange={(e) => setPolicyForm((prev) => ({ ...prev, bandwidthLimitGB: e.target.value }))}
                  placeholder={t('admin.noLimit')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div className="flex gap-2 md:justify-end">
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  {t('admin.cancel')}
                </button>
                <button
                  type="button"
                  onClick={async () => { await onSavePolicy(file.id, policyForm); setIsEditing(false); }}
                  disabled={isSaving}
                  className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-60 flex items-center gap-2"
                >
                  {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                  {t('admin.savePolicy')}
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
