import { useState } from 'react';
import { X, File, Folder, HardDrive, Calendar } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import { formatBytes } from '@/lib/api';

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

export default function ConflictDialog({
  isOpen,
  onClose,
  conflictType,
  incomingName,
  incomingSize,
  incomingDate,
  existingName,
  existingSize,
  existingDate,
  onOverwrite,
  onKeepBoth,
  onMerge,
  onSkip,
}: ConflictDialogProps) {
  const { t } = useI18n();
  const [applyToAll, setApplyToAll] = useState(false);

  if (!isOpen) return null;

  const isFile = conflictType === 'file';

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isFile) {
      e.preventDefault();
      onOverwrite(applyToAll);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (isFile) {
        onSkip(applyToAll);
      } else {
        onClose();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={handleKeyDown}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden">
        <div className="flex justify-between items-center p-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">
            {t(isFile ? 'conflict.fileTitle' : 'conflict.folderTitle')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        <div className="p-4">
          <p className="text-sm text-gray-600 mb-4">
            {t(isFile ? 'conflict.fileDesc' : 'conflict.folderDesc', { name: incomingName })}
          </p>

          {/* Existing item */}
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
            <div className="flex items-center gap-2 mb-2">
              {isFile ? (
                <File className="text-red-500" size={18} />
              ) : (
                <Folder className="text-red-500" size={18} />
              )}
              <span className="text-xs font-semibold text-red-700 uppercase">
                {t('conflict.existing')}
              </span>
            </div>
            <p className="font-medium text-gray-800 truncate">{existingName}</p>
            <div className="flex gap-4 mt-1 text-xs text-gray-500">
              {existingSize !== undefined && (
                <span className="flex items-center gap-1">
                  <HardDrive size={12} />
                  {formatBytes(existingSize)}
                </span>
              )}
              {existingDate && (
                <span className="flex items-center gap-1">
                  <Calendar size={12} />
                  {new Date(existingDate).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>

          {/* Incoming item */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              {isFile ? (
                <File className="text-blue-500" size={18} />
              ) : (
                <Folder className="text-blue-500" size={18} />
              )}
              <span className="text-xs font-semibold text-blue-700 uppercase">
                {t('conflict.incoming')}
              </span>
            </div>
            <p className="font-medium text-gray-800 truncate">{incomingName}</p>
            <div className="flex gap-4 mt-1 text-xs text-gray-500">
              {incomingSize !== undefined && (
                <span className="flex items-center gap-1">
                  <HardDrive size={12} />
                  {formatBytes(incomingSize)}
                </span>
              )}
              {incomingDate && (
                <span className="flex items-center gap-1">
                  <Calendar size={12} />
                  {new Date(incomingDate).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-gray-100 bg-gray-50">
          {isFile ? (
            <div className="flex flex-col gap-2">
              <button
                onClick={() => onOverwrite(applyToAll)}
                className="w-full px-4 py-2.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
              >
                {t('conflict.overwrite')}
              </button>
              <button
                onClick={() => onKeepBoth(applyToAll)}
                className="w-full px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
              >
                {t('conflict.keepBoth')}
              </button>
              <button
                onClick={() => onSkip(applyToAll)}
                className="w-full px-4 py-2.5 text-sm font-medium text-gray-500 bg-transparent hover:bg-gray-100 rounded-lg transition-colors"
              >
                {t('conflict.skip')}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <button
                onClick={() => onMerge(applyToAll)}
                className="w-full px-4 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
              >
                {t('conflict.merge')}
              </button>
              <button
                onClick={onClose}
                className="w-full px-4 py-2.5 text-sm font-medium text-gray-500 bg-transparent hover:bg-gray-100 rounded-lg transition-colors"
              >
                {t('conflict.cancel')}
              </button>
            </div>
          )}

          <label className="flex items-center gap-2 mt-3 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            {t('conflict.applyToAll')}
          </label>
        </div>
      </div>
    </div>
  );
}
