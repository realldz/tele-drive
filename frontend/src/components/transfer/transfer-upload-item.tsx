'use client';

import { X, RotateCcw, CheckCircle2, AlertCircle, Loader2, Ban } from 'lucide-react';
import { formatBytes } from '@/lib/api';
import type { QueueItem } from '@/providers/upload/upload-types';

type Translate = (key: string, vars?: Record<string, string>) => string;

interface TransferUploadItemProps {
  item: QueueItem;
  t: Translate;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}

export default function TransferUploadItem({ item, t, onCancel, onRetry }: TransferUploadItemProps) {
  const isActive = item.status === 'uploading' || item.status === 'pending';

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm text-gray-800 truncate flex-1 mr-2" title={item.relativePath || item.file.name}>
          {item.file.name}
        </span>
        <div className="flex items-center gap-1 flex-shrink-0">
          {item.status === 'uploading' && <Loader2 size={14} className="animate-spin text-blue-500" />}
          {item.status === 'complete' && <CheckCircle2 size={14} className="text-green-500" />}
          {item.status === 'error' && <AlertCircle size={14} className="text-red-500" />}
          {item.status === 'cancelled' && <Ban size={14} className="text-gray-400" />}
          {item.status === 'pending' && <Loader2 size={14} className="text-gray-300" />}

          {isActive && (
            <button
              onClick={() => onCancel(item.id)}
              className="p-0.5 text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
              title={t('upload.cancel')}
            >
              <X size={14} />
            </button>
          )}
          {item.status === 'error' && (
            <button
              onClick={() => onRetry(item.id)}
              className="p-0.5 text-gray-400 hover:text-blue-500 transition-colors cursor-pointer"
              title={t('upload.retry')}
            >
              <RotateCcw size={14} />
            </button>
          )}
        </div>
      </div>

      {isActive && (
        <div className="w-full bg-gray-200 rounded-full h-1.5">
          <div className="bg-blue-600 h-1.5 rounded-full transition-all duration-300" style={{ width: `${item.progress}%` }} />
        </div>
      )}

      <div className="flex justify-between mt-1">
        <span className="text-xs text-gray-500">
          {item.status === 'uploading' && `${formatBytes(item.uploadedBytes)} / ${formatBytes(item.totalBytes)}`}
          {item.status === 'pending' && t('upload.pending')}
          {item.status === 'complete' && t('upload.complete')}
          {item.status === 'error' && (item.errorMessage || t('upload.errorItem'))}
          {item.status === 'cancelled' && t('upload.cancelledItem')}
        </span>
        {item.status === 'uploading' && <span className="text-xs text-gray-500">{item.progress}%</span>}
      </div>
    </div>
  );
}
