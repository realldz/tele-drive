'use client';

import { useState } from 'react';
import { X, ChevronDown, ChevronUp, CheckCircle2, Loader2 } from 'lucide-react';
import { useI18n } from '@/providers/i18n-context';
import { useUpload } from '@/providers/upload/upload-provider';
import { useDownload } from '@/providers/download-context';
import TransferUploadItem from '@/components/transfer/transfer-upload-item';
import TransferDownloadItem from '@/components/transfer/transfer-download-item';

const ACTIVE_DOWNLOAD_STATUSES = ['pending', 'collecting', 'zipping', 'splitting'];

export default function TransferPanel() {
  const { t } = useI18n();
  const {
    queue: uploadQueue, isUploading,
    cancelItem: cancelUploadItem, cancelAll: cancelAllUploads,
    clearCompleted: clearCompletedUploads, retryItem: retryUploadItem,
  } = useUpload();

  const {
    jobs: downloadJobs, hasActiveJobs: hasActiveDownloads,
    cancelJob: cancelDownloadJob, clearCompleted: clearCompletedDownloads,
  } = useDownload();

  const [isExpanded, setIsExpanded] = useState(true);

  const totalUploads = uploadQueue.length;
  const completedUploads = uploadQueue.filter(item => item.status === 'complete').length;
  const hasFinishedUploads = uploadQueue.every(
    item => item.status === 'complete' || item.status === 'error' || item.status === 'cancelled',
  );

  const totalDownloads = downloadJobs.length;
  const activeDownloads = downloadJobs.filter(j => ACTIVE_DOWNLOAD_STATUSES.includes(j.status)).length;
  const hasFinishedDownloads = downloadJobs.every(
    j => j.status === 'ready' || j.status === 'failed' || j.status === 'expired',
  );

  if (totalUploads === 0 && totalDownloads === 0) return null;

  const totalActive =
    uploadQueue.filter(item => item.status === 'pending' || item.status === 'uploading').length + activeDownloads;

  let headerText: string;
  if (totalUploads > 0 && totalDownloads === 0) {
    headerText = hasFinishedUploads
      ? t('upload.allComplete', { total: String(completedUploads) })
      : t('upload.queueHeader', { completed: String(completedUploads), total: String(totalUploads) });
  } else if (totalDownloads > 0 && totalUploads === 0) {
    headerText = hasFinishedDownloads ? t('downloadZip.ready') : t('downloadZip.preparing');
  } else {
    headerText = `Truyền tải (${totalActive} đang chạy)`;
  }

  const handleClearAll = () => { clearCompletedUploads(); clearCompletedDownloads(); };

  const handleCancelAll = () => {
    cancelAllUploads();
    downloadJobs.forEach(job => {
      if (ACTIVE_DOWNLOAD_STATUSES.includes(job.status)) cancelDownloadJob(job.jobId);
    });
  };

  const hasAnyActive = isUploading || hasActiveDownloads;
  const hasAnyFinished =
    (totalUploads > 0 && hasFinishedUploads) || (totalDownloads > 0 && hasFinishedDownloads);

  return (
    <div className="fixed bottom-4 right-4 w-88 bg-white rounded-xl shadow-2xl border border-gray-200 z-50 overflow-hidden transition-all duration-300">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200 cursor-pointer select-none"
        onClick={() => setIsExpanded(prev => !prev)}
      >
        <div className="flex items-center gap-2 min-w-0">
          {hasAnyActive && <Loader2 size={16} className="animate-spin text-blue-600 flex-shrink-0" />}
          {!hasAnyActive && hasAnyFinished && <CheckCircle2 size={16} className="text-green-600 flex-shrink-0" />}
          <span className="text-sm font-semibold text-gray-800 truncate">{headerText}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {hasAnyActive && (
            <button
              onClick={(e) => { e.stopPropagation(); handleCancelAll(); }}
              className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors cursor-pointer"
            >
              {t('upload.cancelAll')}
            </button>
          )}
          {hasAnyFinished && (
            <button
              onClick={(e) => { e.stopPropagation(); handleClearAll(); }}
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
            onClick={(e) => { e.stopPropagation(); handleClearAll(); }}
            className="p-1 text-gray-400 hover:text-gray-600 rounded transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Queue List */}
      {isExpanded && (
        <div className="max-h-80 overflow-y-auto divide-y divide-gray-100">
          {uploadQueue.map(item => (
            <TransferUploadItem key={item.id} item={item} t={t} onCancel={cancelUploadItem} onRetry={retryUploadItem} />
          ))}

          {totalUploads > 0 && totalDownloads > 0 && (
            <div className="bg-gray-100 text-[10px] font-bold text-gray-400 px-4 py-1 select-none">TẢI XUỐNG</div>
          )}

          {downloadJobs.map(job => (
            <TransferDownloadItem key={job.jobId} job={job} t={t} onCancel={cancelDownloadJob} />
          ))}
        </div>
      )}
    </div>
  );
}
