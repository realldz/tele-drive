'use client';

import { useEffect, useState } from 'react';
import { X, Download, Loader2, FileIcon } from 'lucide-react';
import { getFileIcon } from '@/lib/file-icon';
import { useI18n } from '@/components/i18n-context';
import { API_URL, api, requestDownloadToken, getStreamUrl, getApiErrorMessage, parseBandwidthError } from '@/lib/api';
import { useStream } from '@/hooks/use-stream';
import dynamic from 'next/dynamic';
import toast from 'react-hot-toast';

const PreviewRenderer = dynamic(() => import('@/components/preview-renderer'), { ssr: false });

interface FileInfo {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface FilePreviewModalProps {
  fileId: string | null;
  onClose: () => void;
}

export default function FilePreviewModal({ fileId, onClose }: FilePreviewModalProps) {
  const { t } = useI18n();
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const { streamUrl, isLoading: isStreamLoading, setupStream, teardownStream } = useStream();

  useEffect(() => {
    if (!fileId) {
      setFileInfo(null);
      setError(null);
      teardownStream();
      return;
    }

    setIsLoading(true);
    setError(null);
    setFileInfo(null);

    api
      .get(`${API_URL}/files/${fileId}/info`)
      .then(async (res) => {
        setFileInfo(res.data);
        await setupStream(getStreamUrl(fileId));
      })
      .catch((err: unknown) => {
        setError(getApiErrorMessage(err, 'Failed to load file'));
      })
      .finally(() => setIsLoading(false));
  }, [fileId, setupStream, teardownStream]);

  // ESC key handler
  useEffect(() => {
    if (!fileId) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [fileId, onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (!fileId) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [fileId]);

  async function handleDownload() {
    if (!fileInfo) return;
    try {
      const { url } = await requestDownloadToken(fileInfo.id);
      toast(t('dashboard.downloadStarted'), { icon: '⬇️', duration: 2000 });
      const link = document.createElement('a');
      link.href = API_URL + url;
      link.setAttribute('download', fileInfo.filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err: unknown) {
      const bw = parseBandwidthError(err);
      if (bw) {
        toast.error(
          bw.resetTime
            ? t('dashboard.bandwidthExceededAt', { time: bw.resetTime })
            : t('dashboard.bandwidthExceeded'),
        );
      } else {
        toast.error(getApiErrorMessage(err, t('dashboard.downloadError')));
      }
    }
  }

  if (!fileId) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/70"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Header */}
      <header className="flex h-14 items-center justify-between px-4 bg-white/95 border-b border-gray-200 flex-none z-10">
        <div className="flex items-center gap-3 min-w-0">
          {fileInfo && getFileIcon(fileInfo.mimeType, 'h-5 w-5 text-gray-500')}
          <h1 className="truncate font-semibold text-gray-800 text-sm">
            {fileInfo?.filename || '...'}
          </h1>
          {fileInfo && (
            <span className="text-xs text-gray-500 hidden sm:inline-block">
              {(fileInfo.size / (1024 * 1024)).toFixed(2)} MB
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-none ml-4">
          {fileInfo && (
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 transition-colors"
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline-block">{t('preview.download')}</span>
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-md transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 relative overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {(isLoading || isStreamLoading) && (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
          </div>
        )}

        {error && !isStreamLoading && (
          <div className="flex h-full flex-col items-center justify-center p-4">
            <div className="rounded-lg bg-white p-8 text-center shadow-md">
              <FileIcon className="mx-auto mb-4 h-16 w-16 text-red-400" />
              <h2 className="mb-2 text-xl font-semibold">{t('preview.errorTitle')}</h2>
              <p className="text-gray-600">{error}</p>
            </div>
          </div>
        )}

        {fileInfo && !isStreamLoading && !error && streamUrl && (
          <PreviewRenderer
            streamUrl={streamUrl}
            onDownload={handleDownload}
            fileInfo={fileInfo}
            t={t}
          />
        )}
      </main>
    </div>
  );
}
