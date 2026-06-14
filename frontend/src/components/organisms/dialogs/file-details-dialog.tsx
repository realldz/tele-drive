'use client';

import React from 'react';
import { useI18n, LOCALE_DATE_MAP } from '@/providers/i18n-context';
import { formatBytes } from '@/lib/api';
import { getFileIcon } from '@/lib/file-icon';
import Modal from '@/components/molecules/modal';
import Button from '@/components/atoms/button';
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

  if (!item) return null;

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
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      title={t(isFile ? 'details.title' : 'details.titleFolder')}
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          {t('details.close')}
        </Button>
      }
    >
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-xs text-gray-500 font-medium uppercase tracking-wide">{row.label}</dt>
            <dd className="text-sm text-gray-800 mt-0.5 break-all">{row.value}</dd>
          </div>
        ))}
      </div>
    </Modal>
  );
}
