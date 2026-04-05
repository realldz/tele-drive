'use client';

import { useState } from 'react';
import { X, ChevronDown, ChevronUp, RotateCcw, CheckCircle2, AlertCircle, Loader2, Ban } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import { useUpload } from '@/components/upload-context';
import { formatBytes } from '@/lib/api';

export default function UploadPanel() {
  const { t } = useI18n();
  const { queue, isUploading, cancelItem, cancelAll, clearCompleted, retryItem } = useUpload();
  const [isExpanded, setIsExpanded] = useState(true);

  if (queue.length === 0) return null;

  const completedCount = queue.filter(item => item.status === 'complete').length;
  const totalCount = queue.length;
  const hasFinished = queue.every(item =>
    item.status === 'complete' || item.status === 'error' || item.status === 'cancelled'
  );

  const headerText = hasFinished
    ? t('upload.allComplete', { total: String(completedCount) })
    : t('upload.queueHeader', { completed: String(completedCount), total: String(totalCount) });

  return (
    <div className="fixed bottom-4 right-4 w-80 bg-white rounded-xl shadow-2xl border border-gray-200 z-50 overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200 cursor-pointer select-none"
        onClick={() => setIsExpanded(prev => !prev)}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isUploading && <Loader2 size={16} className="animate-spin text-blue-600 flex-shrink-0" />}
          {hasFinished && <CheckCircle2 size={16} className="text-green-600 flex-shrink-0" />}
          <span className="text-sm font-semibold text-gray-800 truncate">{headerText}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {isUploading && (
            <button
              onClick={(e) => { e.stopPropagation(); cancelAll(); }}
              className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors cursor-pointer"
            >
              {t('upload.cancelAll')}
            </button>
          )}
          {hasFinished && (
            <button
              onClick={(e) => { e.stopPropagation(); clearCompleted(); }}
              className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition-colors cursor-pointer"
            >
              {t('upload.clear')}
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setIsExpanded(prev => !prev); }}
            className="p-1 text-gray-400 hover:text-gray-600 rounded transition-colors cursor-pointer"
          >
            {isExpanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); clearCompleted(); }}
            className="p-1 text-gray-400 hover:text-gray-600 rounded transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Queue List */}
      {isExpanded && (
        <div className="max-h-72 overflow-y-auto divide-y divide-gray-100">
          {queue.map(item => (
            <div key={item.id} className="px-4 py-3">
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

                  {(item.status === 'pending' || item.status === 'uploading') && (
                    <button
                      onClick={() => cancelItem(item.id)}
                      className="p-0.5 text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
                      title={t('upload.cancel')}
                    >
                      <X size={14} />
                    </button>
                  )}
                  {item.status === 'error' && (
                    <button
                      onClick={() => retryItem(item.id)}
                      className="p-0.5 text-gray-400 hover:text-blue-500 transition-colors cursor-pointer"
                      title={t('upload.retry')}
                    >
                      <RotateCcw size={14} />
                    </button>
                  )}
                </div>
              </div>

              {(item.status === 'uploading' || item.status === 'pending') && (
                <div className="w-full bg-gray-200 rounded-full h-1.5">
                  <div
                    className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
                    style={{ width: `${item.progress}%` }}
                  />
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
                {item.status === 'uploading' && (
                  <span className="text-xs text-gray-500">{item.progress}%</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
