'use client';

import React from 'react';
import { X } from 'lucide-react';
import { useI18n, LOCALE_DATE_MAP } from '@/components/i18n-context';
import { formatBytes } from '@/lib/api';
import { getFileIcon } from '@/lib/file-icon';
import type { FileRecord, FolderRecord } from '@/lib/types';

interface FileDetailsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  item: FileRecord | FolderRecord | null;
  itemType: 'file' | 'folder';
}

function isFileRecord(item: FileRecord | FolderRecord): item is FileRecord {
  return 'filename' in item;
}

export default function FileDetailsDialog({ isOpen, onClose, item, itemType }: FileDetailsDialogProps) {
  const { t, locale } = useI18n();

  if (!isOpen || !item) return null;

  const isFile = itemType === 'file' && isFileRecord(item);
  const name = isFile ? item.filename : (item as FolderRecord).name;
  const formatDate = (d: string) => new Date(d).toLocaleString(LOCALE_DATE_MAP[locale]);

  const rows: Array<{ label: string; value: string | React.ReactNode }> = [
    { label: t(isFile ? 'details.filename' : 'details.name'), value: name },
  ];

  if (isFile) {
    rows.push(
      { label: t('details.size'), value: formatBytes(Number(item.size)) },
      { label: t('details.type'), value: <span className="flex items-center gap-2">{getFileIcon(item.mimeType, 'w-4 h-4')}{item.mimeType}</span> },
      { label: t('details.chunks'), value: String(item.totalChunks) },
    );
  }

  rows.push(
    { label: t('details.visibility'), value: item.visibility === 'PRIVATE' ? t('share.private') : t('share.public') },
    { label: t('details.created'), value: formatDate(item.createdAt) },
    { label: t('details.updated'), value: formatDate(item.updatedAt) },
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center p-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">
            {t(isFile ? 'details.title' : 'details.titleFolder')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          {rows.map((row) => (
            <div key={row.label}>
              <dt className="text-xs text-gray-500 font-medium uppercase tracking-wide">{row.label}</dt>
              <dd className="text-sm text-gray-800 mt-0.5 break-all">{row.value}</dd>
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-gray-100 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 font-medium text-sm"
          >
            {t('details.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
