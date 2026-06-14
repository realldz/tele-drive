'use client';

import { useState, useEffect } from 'react';
import { File, Folder, HardDrive, Calendar } from 'lucide-react';
import { useI18n } from '@/providers/i18n-context';
import { formatBytes } from '@/lib/api';
import Modal from '@/components/molecules/modal';
import Button from '@/components/atoms/button';

interface ConflictDialogProps {
  isOpen: boolean;
  onClose: () => void;
  conflictType: 'file' | 'folder';
  incomingName: string;
  incomingSize?: number;
  incomingDate?: string;
  existingName: string;
  existingSize?: number;
  existingDate?: string;
  onOverwrite: (applyToAll: boolean) => void;
  onKeepBoth: (applyToAll: boolean) => void;
  onMerge: (applyToAll: boolean) => void;
  onSkip: (applyToAll: boolean) => void;
}

interface ItemCardProps {
  variant: 'existing' | 'incoming';
  isFile: boolean;
  label: string;
  name: string;
  size?: number;
  date?: string;
}

const ACCENT_CLASSES = {
  existing: { card: 'bg-red-50 border-red-200', icon: 'text-red-500', label: 'text-red-700' },
  incoming: { card: 'bg-blue-50 border-blue-200', icon: 'text-blue-500', label: 'text-blue-700' },
} as const;

function ItemCard({ variant, isFile, label, name, size, date }: ItemCardProps) {
  const accent = ACCENT_CLASSES[variant];
  const Icon = isFile ? File : Folder;
  return (
    <div className={`${accent.card} border rounded-lg p-3`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={accent.icon} size={18} />
        <span className={`text-xs font-semibold ${accent.label} uppercase`}>{label}</span>
      </div>
      <p className="font-medium text-gray-800 truncate">{name}</p>
      <div className="flex gap-4 mt-1 text-xs text-gray-500">
        {size !== undefined && (
          <span className="flex items-center gap-1"><HardDrive size={12} />{formatBytes(size)}</span>
        )}
        {date && (
          <span className="flex items-center gap-1"><Calendar size={12} />{new Date(date).toLocaleDateString()}</span>
        )}
      </div>
    </div>
  );
}

export default function ConflictDialog({
  isOpen, onClose, conflictType,
  incomingName, incomingSize, incomingDate,
  existingName, existingSize, existingDate,
  onOverwrite, onKeepBoth, onMerge, onSkip,
}: ConflictDialogProps) {
  const { t } = useI18n();
  const [applyToAll, setApplyToAll] = useState(false);
  const isFile = conflictType === 'file';

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && isFile) {
        e.preventDefault();
        onOverwrite(applyToAll);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (isFile) onSkip(applyToAll);
        else onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, isFile, applyToAll, onOverwrite, onSkip, onClose]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t(isFile ? 'conflict.fileTitle' : 'conflict.folderTitle')}
      size="lg"
      dismissOnBackdrop={false}
    >
      <p className="text-sm text-gray-600 mb-4">
        {t(isFile ? 'conflict.fileDesc' : 'conflict.folderDesc', { name: incomingName })}
      </p>

      <div className="space-y-3">
        <ItemCard variant="existing" isFile={isFile} label={t('conflict.existing')}
          name={existingName} size={existingSize} date={existingDate} />
        <ItemCard variant="incoming" isFile={isFile} label={t('conflict.incoming')}
          name={incomingName} size={incomingSize} date={incomingDate} />
      </div>

      <div className="flex flex-col gap-2 mt-4">
        {isFile ? (
          <>
            <Button variant="danger" fullWidth onClick={() => onOverwrite(applyToAll)}>{t('conflict.overwrite')}</Button>
            <Button variant="outline" fullWidth onClick={() => onKeepBoth(applyToAll)}>{t('conflict.keepBoth')}</Button>
            <Button variant="subtle" fullWidth onClick={() => onSkip(applyToAll)}>{t('conflict.skip')}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" fullWidth onClick={() => onMerge(applyToAll)}>{t('conflict.merge')}</Button>
            <Button variant="subtle" fullWidth onClick={onClose}>{t('conflict.cancel')}</Button>
          </>
        )}
      </div>

      <label className="flex items-center gap-2 mt-3 text-sm text-gray-600 cursor-pointer">
        <input
          type="checkbox"
          checked={applyToAll}
          onChange={(e) => setApplyToAll(e.target.checked)}
          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        {t('conflict.applyToAll')}
      </label>
    </Modal>
  );
}
