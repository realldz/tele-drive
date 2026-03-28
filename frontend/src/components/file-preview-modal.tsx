'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import axios from 'axios';
import { X, Download, Loader2, FileIcon } from 'lucide-react';
import { getFileIcon } from '@/lib/file-icon';
import { useAuth } from '@/components/auth-context';
import { useI18n, LOCALE_DATE_MAP } from '@/components/i18n-context';
import { API_URL, requestDownloadToken, requestStreamCookie, clearStreamCookie, getStreamUrl, getApiErrorMessage, formatBandwidthResetTime } from '@/lib/api';
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
  const { token } = useAuth();
  const { t, locale } = useI18n();
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Request stream cookie + download token khi modal mở
  const setupUrls = useCallback(async (fId: string) => {
    try {
      const [cookieRes, dlRes] = await Promise.all([
        requestStreamCookie(),
        requestDownloadToken(fId),
      ]);
      setStreamUrl(getStreamUrl(fId));
      setDownloadUrl(API_URL + dlRes.url);

      // Auto-refresh cookie ở 80% TTL
      const refreshMs = cookieRes.ttl * 800; // 80% of TTL in ms
      refreshTimerRef.current = setTimeout(function refresh() {
        requestStreamCookie()
          .then((res) => {
            refreshTimerRef.current = setTimeout(refresh, res.ttl * 800);
          })
          .catch(() => { /* cookie refresh failed, stream may break */ });
      }, refreshMs);
    } catch (err: unknown) {
      // Fallback: dùng legacy URL nếu signed URL fail
      setStreamUrl(`${API_URL}/files/${fId}/stream?token=${token}`);
      setDownloadUrl(`${API_URL}/files/${fId}/download?token=${token}`);
      
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        const resetTime = formatBandwidthResetTime(err.response.headers?.['x-bandwidth-reset'], LOCALE_DATE_MAP[locale]);
        toast.error(resetTime
          ? t('dashboard.bandwidthExceededAt', { time: resetTime })
          : t('dashboard.bandwidthExceeded'));
      } else {
        const msg = getApiErrorMessage(err, '');
        if (msg) toast.error(msg);
      }
    }
  }, [token, locale, t]);

  useEffect(() => {
    if (!fileId) {
      setFileInfo(null);
      setError(null);
      setStreamUrl(null);
      setDownloadUrl(null);
      // Cleanup cookie + timer
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      clearStreamCookie().catch(() => { });
      return;
    }

    setIsLoading(true);
    setError(null);
    setFileInfo(null);
    setStreamUrl(null);
    setDownloadUrl(null);

    axios
      .get(`${API_URL}/files/${fileId}/info`)
      .then(async (res) => {
        setFileInfo(res.data);
        await setupUrls(fileId);
      })
      .catch((err: unknown) => {
        const message = axios.isAxiosError(err) ? err.response?.data?.message : undefined;
        setError(message || 'Failed to load file');
      })
      .finally(() => setIsLoading(false));

    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [fileId, setupUrls]);

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

  const handleDownload = useCallback(async () => {
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
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        const resetTime = formatBandwidthResetTime(err.response.headers?.['x-bandwidth-reset'], LOCALE_DATE_MAP[locale]);
        toast.error(resetTime
          ? t('dashboard.bandwidthExceededAt', { time: resetTime })
          : t('dashboard.bandwidthExceeded'));
      } else {
        toast.error(getApiErrorMessage(err, t('dashboard.downloadError')));
      }
    }
  }, [fileInfo, locale, t]);

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
        {isLoading && (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
          </div>
        )}

        {error && (
          <div className="flex h-full flex-col items-center justify-center p-4">
            <div className="rounded-lg bg-white p-8 text-center shadow-md">
              <FileIcon className="mx-auto mb-4 h-16 w-16 text-red-400" />
              <h2 className="mb-2 text-xl font-semibold">{t('preview.errorTitle')}</h2>
              <p className="text-gray-600">{error}</p>
            </div>
          </div>
        )}

        {fileInfo && !isLoading && !error && streamUrl && downloadUrl && (
          <PreviewRenderer
            streamUrl={streamUrl}
            downloadUrl={downloadUrl}
            fileInfo={fileInfo}
            t={t}
          />
        )}
      </main>
    </div>
  );
}
