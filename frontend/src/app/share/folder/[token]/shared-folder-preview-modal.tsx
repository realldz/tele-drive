'use client';

import { useEffect, useCallback } from 'react';
import { X, Download, Loader2 } from 'lucide-react';
import { getFileIcon } from '@/lib/file-icon';
import { useI18n } from '@/components/i18n-context';
import { API_URL, requestShareFolderDownloadToken, parseBandwidthError, getShareFolderStreamUrl } from '@/lib/api';
import { useGuestStream } from '@/hooks/use-stream';
import dynamic from 'next/dynamic';
import toast from 'react-hot-toast';
import type { FileRecord } from '@/lib/types';

const PreviewRenderer = dynamic(() => import('@/components/preview-renderer'), { ssr: false });

interface SharedFolderPreviewModalProps {
  shareToken: string;
  file: FileRecord | null;
  onClose: () => void;
}

export default function SharedFolderPreviewModal({ shareToken, file, onClose }: SharedFolderPreviewModalProps) {
  const { t } = useI18n();
  const { streamUrl, isLoading: isSettingUp, setupStream, teardownStream } = useGuestStream();

  useEffect(() => {
    if (!file) {
      teardownStream();
      return;
    }

    setupStream(getShareFolderStreamUrl(shareToken, file.id));
  }, [file, shareToken, setupStream, teardownStream]);

  // ESC key handler
  useEffect(() => {
    if (!file) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [file, onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (!file) return;
    const originalStyle = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = originalStyle; };
  }, [file]);

  const handleDownload = useCallback(async () => {
    if (!file) return;
    try {
      const { url } = await requestShareFolderDownloadToken(shareToken, file.id);
      toast(t('dashboard.downloadStarted'), { icon: '⬇️', duration: 2000 });
      const link = document.createElement('a');
      link.href = API_URL + url;
      link.setAttribute('download', file.filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err: unknown) {
      const bw = parseBandwidthError(err);
      if (bw) {
        toast.error(bw.resetTime
          ? t('dashboard.bandwidthExceededAt', { time: bw.resetTime })
          : t('dashboard.bandwidthExceeded'));
      } else {
        toast.error(t('dashboard.downloadError'));
      }
    }
  }, [file, shareToken, t]);

  if (!file) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/70"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <header className="flex h-14 items-center justify-between px-4 bg-white/95 border-b border-gray-200 flex-none z-10">
        <div className="flex items-center gap-3 min-w-0">
          {getFileIcon(file.mimeType, 'h-5 w-5 text-gray-500')}
          <h1 className="truncate font-semibold text-gray-800 text-sm">
            {file.filename}
          </h1>
          <span className="text-xs text-gray-500 hidden sm:inline-block">
            {(Number(file.size) / (1024 * 1024)).toFixed(2)} MB
          </span>
        </div>
        <div className="flex items-center gap-2 flex-none ml-4">
          <button
            onClick={handleDownload}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 transition-colors"
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline-block">{t('preview.download')}</span>
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-md transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </header>

      <main className="flex-1 relative overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {isSettingUp && (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
          </div>
        )}

        {!isSettingUp && streamUrl && (
          <PreviewRenderer
            streamUrl={streamUrl}
            onDownload={handleDownload}
            fileInfo={{
              filename: file.filename,
              mimeType: file.mimeType,
              size: Number(file.size),
            }}
            t={t}
          />
        )}
      </main>
    </div>
  );
}