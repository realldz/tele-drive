'use client';

import { X, CheckCircle2, AlertCircle, Loader2, Ban, Download } from 'lucide-react';
import { formatBytes, resolveTransferLink } from '@/lib/api';
import type { DownloadJob } from '@/providers/download-context';

type Translate = (key: string, vars?: Record<string, string>) => string;

interface TransferDownloadItemProps {
  job: DownloadJob;
  t: Translate;
  onCancel: (jobId: string) => void;
}

function statusLabel(job: DownloadJob, t: Translate): string {
  switch (job.status) {
    case 'pending': return t('downloadZip.preparing');
    case 'collecting': return t('downloadZip.collecting');
    case 'zipping': return t('downloadZip.zipping');
    case 'ready': return t('downloadZip.ready');
    case 'expired': return t('downloadZip.expired');
    default: return job.error || t('downloadZip.failed');
  }
}

export default function TransferDownloadItem({ job, t, onCancel }: TransferDownloadItemProps) {
  const hasActive = ['pending', 'collecting', 'zipping'].includes(job.status);
  const progress = job.totalFiles > 0 ? Math.round((job.processedFiles / job.totalFiles) * 100) : 0;

  return (
    <div className="px-4 py-3 bg-blue-50/10">
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
              onClick={() => onCancel(job.jobId)}
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
          <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>
      )}

      <div className="flex justify-between mt-1 items-center">
        <span className="text-xs text-gray-500">
          {statusLabel(job, t)}
          {hasActive && job.totalFiles > 0 && ` (${job.processedFiles}/${job.totalFiles})`}
        </span>
        {!hasActive && job.status === 'ready' && (
          <span className="text-xs font-semibold text-gray-600">{formatBytes(job.totalSize)}</span>
        )}
      </div>

      {job.status === 'ready' && job.parts.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {job.parts.map((part) => (
            <a
              key={part.index}
              href={resolveTransferLink(part.downloadUrl)}
              download=""
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
                <span className="text-[10px] text-gray-400 font-mono">{formatBytes(part.size)}</span>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
