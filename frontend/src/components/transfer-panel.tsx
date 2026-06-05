'use client';

import { useState } from 'react';
import {
  X,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Ban,
  Download,
} from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import { useUpload } from '@/components/upload-context';
import { useDownload } from '@/components/download-context';
import { formatBytes, API_URL } from '@/lib/api';

export default function TransferPanel() {
  const { t } = useI18n();
  const {
    queue: uploadQueue,
    isUploading,
    cancelItem: cancelUploadItem,
    cancelAll: cancelAllUploads,
    clearCompleted: clearCompletedUploads,
    retryItem: retryUploadItem,
  } = useUpload();

  const {
    jobs: downloadJobs,
    hasActiveJobs: hasActiveDownloads,
    cancelJob: cancelDownloadJob,
    clearCompleted: clearCompletedDownloads,
  } = useDownload();

  const [isExpanded, setIsExpanded] = useState(true);

  const totalUploads = uploadQueue.length;
  const completedUploads = uploadQueue.filter(item => item.status === 'complete').length;
  const hasFinishedUploads = uploadQueue.every(
    item => item.status === 'complete' || item.status === 'error' || item.status === 'cancelled'
  );

  const totalDownloads = downloadJobs.length;
  const activeDownloads = downloadJobs.filter(
    j => ['pending', 'collecting', 'zipping', 'splitting'].includes(j.status)
  ).length;
  const hasFinishedDownloads = downloadJobs.every(
    j => j.status === 'ready' || j.status === 'failed' || j.status === 'expired'
  );

  if (totalUploads === 0 && totalDownloads === 0) return null;

  // Header construction
  const totalActive =
    uploadQueue.filter(item => item.status === 'pending' || item.status === 'uploading').length +
    activeDownloads;

  let headerText = '';
  if (totalUploads > 0 && totalDownloads === 0) {
    headerText = hasFinishedUploads
      ? t('upload.allComplete', { total: String(completedUploads) })
      : t('upload.queueHeader', { completed: String(completedUploads), total: String(totalUploads) });
  } else if (totalDownloads > 0 && totalUploads === 0) {
    headerText = hasFinishedDownloads
      ? t('downloadZip.ready')
      : t('downloadZip.preparing');
  } else {
    headerText = `Truyền tải (${totalActive} đang chạy)`;
  }

  const handleClearAll = () => {
    clearCompletedUploads();
    clearCompletedDownloads();
  };

  const handleCancelAll = () => {
    cancelAllUploads();
    // Cancel all active downloads
    downloadJobs.forEach(job => {
      if (['pending', 'collecting', 'zipping', 'splitting'].includes(job.status)) {
        cancelDownloadJob(job.jobId);
      }
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
              onClick={(e) => {
                e.stopPropagation();
                handleCancelAll();
              }}
              className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors cursor-pointer"
            >
              {t('upload.cancelAll')}
            </button>
          )}
          {hasAnyFinished && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleClearAll();
              }}
              className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition-colors cursor-pointer"
            >
              {t('upload.clear')}
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(prev => !prev);
            }}
            className="p-1 text-gray-400 hover:text-gray-600 rounded transition-colors cursor-pointer"
          >
            {isExpanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleClearAll();
            }}
            className="p-1 text-gray-400 hover:text-gray-600 rounded transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Queue List */}
      {isExpanded && (
        <div className="max-h-80 overflow-y-auto divide-y divide-gray-100">
          {/* Upload Items */}
          {uploadQueue.map(item => (
            <div key={item.id} className="px-4 py-3">
              <div className="flex items-center justify-between mb-1">
                <span
                  className="text-sm text-gray-800 truncate flex-1 mr-2"
                  title={item.relativePath || item.file.name}
                >
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
                      onClick={() => cancelUploadItem(item.id)}
                      className="p-0.5 text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
                      title={t('upload.cancel')}
                    >
                      <X size={14} />
                    </button>
                  )}
                  {item.status === 'error' && (
                    <button
                      onClick={() => retryUploadItem(item.id)}
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
                  {item.status === 'uploading' &&
                    `${formatBytes(item.uploadedBytes)} / ${formatBytes(item.totalBytes)}`}
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

          {/* Separator if both queues exist */}
          {totalUploads > 0 && totalDownloads > 0 && (
            <div className="bg-gray-100 text-[10px] font-bold text-gray-400 px-4 py-1 select-none">
              TẢI XUỐNG
            </div>
          )}

          {/* Download Items */}
          {downloadJobs.map(job => {
            const hasActive = ['pending', 'collecting', 'zipping', 'splitting'].includes(job.status);
            const progress =
              job.totalFiles > 0 ? Math.round((job.processedFiles / job.totalFiles) * 100) : 0;

            let statusLabel = '';
            switch (job.status) {
              case 'pending':
                statusLabel = t('downloadZip.preparing');
                break;
              case 'collecting':
                statusLabel = t('downloadZip.collecting');
                break;
              case 'zipping':
                statusLabel = t('downloadZip.zipping');
                break;
              case 'splitting':
                statusLabel = t('downloadZip.splitting');
                break;
              case 'ready':
                statusLabel = t('downloadZip.ready');
                break;
              case 'expired':
                statusLabel = t('downloadZip.expired');
                break;
              case 'failed':
              default:
                statusLabel = job.error || t('downloadZip.failed');
                break;
            }

            return (
              <div key={job.jobId} className="px-4 py-3 bg-blue-50/10">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-800 truncate flex-1 mr-2" title={job.label}>
                    {job.label}.zip
                  </span>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {hasActive && <Loader2 size={14} className="animate-spin text-blue-500" />}
                    {job.status === 'ready' && <CheckCircle2 size={14} className="text-green-500" />}
                    {job.status === 'failed' && <AlertCircle size={14} className="text-red-500" />}
                    {job.status === 'expired' && <Ban size={14} className="text-gray-400" />}

                    {hasActive && (
                      <button
                        onClick={() => cancelDownloadJob(job.jobId)}
                        className="p-0.5 text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
                        title={t('downloadZip.cancel')}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {hasActive && (
                  <div className="w-full bg-gray-200 rounded-full h-1.5 mb-1">
                    <div
                      className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                )}

                <div className="flex justify-between mt-1 items-center">
                  <span className="text-xs text-gray-500">
                    {statusLabel}
                    {hasActive && job.totalFiles > 0 && ` (${job.processedFiles}/${job.totalFiles})`}
                  </span>
                  {!hasActive && job.status === 'ready' && (
                    <span className="text-xs font-semibold text-gray-600">
                      {formatBytes(job.totalSize)}
                    </span>
                  )}
                </div>

                {/* Part Links for ready state */}
                {job.status === 'ready' && job.parts.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {job.parts.map((part) => (
                      <a
                        key={part.index}
                        href={API_URL + part.downloadUrl}
                        download={`download.zip.${String(part.index + 1).padStart(3, '0')}`}
                        className="flex items-center justify-between text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100/70 border border-blue-100 rounded px-2.5 py-1.5 transition-colors cursor-pointer font-medium"
                      >
                        <div className="flex items-center gap-1.5">
                          <Download size={12} className="flex-shrink-0" />
                          <span>
                            {job.parts.length > 1
                              ? t('downloadZip.downloadPart', { index: String(part.index + 1), size: formatBytes(part.size) })
                              : t('downloadZip.download')}
                          </span>
                        </div>
                        {job.parts.length > 1 && (
                          <span className="text-[10px] text-gray-400 font-mono">
                            {formatBytes(part.size)}
                          </span>
                        )}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
