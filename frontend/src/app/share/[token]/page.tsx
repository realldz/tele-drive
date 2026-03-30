'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import axios from 'axios';
import { Download, FileText, AlertCircle, Loader2 } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import GuestLanguageSwitcher from '@/components/guest-language-switcher';
import toast from 'react-hot-toast';
import dynamic from 'next/dynamic';

import { API_URL, formatBandwidthResetTime, formatSize, requestShareDownloadToken, requestGuestStreamCookie, clearStreamCookie, getShareStreamUrl } from '@/lib/api';
import type { SharedFileInfo } from '@/lib/types';

const PreviewRenderer = dynamic(() => import('@/components/preview-renderer'), { ssr: false });

const isPreviewable = (mimeType?: string) => {
  if (!mimeType) return false;
  return mimeType.startsWith('image/') ||
    mimeType.startsWith('video/') ||
    mimeType.startsWith('audio/') ||
    mimeType === 'application/pdf' ||
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml';
};

export default function SharePage() {
  const params = useParams();
  const token = params.token as string;
  const { t } = useI18n();

  const [fileInfo, setFileInfo] = useState<SharedFileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const waitForCookieCommit = (): Promise<void> =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

  const setupStream = useCallback(async () => {
    try {
      const cookieRes = await requestGuestStreamCookie();
      await waitForCookieCommit();
      setStreamUrl(getShareStreamUrl(token));

      const refreshMs = cookieRes.ttl * 800;
      refreshTimerRef.current = setTimeout(function refresh() {
        requestGuestStreamCookie()
          .then((res) => { refreshTimerRef.current = setTimeout(refresh, res.ttl * 800); })
          .catch(() => { });
      }, refreshMs);
    } catch {
      // Fallback
      setStreamUrl(`${API_URL}/files/share/stream/${token}`);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const fetchFileInfo = async () => {
      try {
        const res = await axios.get(`${API_URL}/files/share/${token}`);
        const info = res.data;
        setFileInfo(info);
        if (isPreviewable(info.mimeType)) {
          await setupStream();
        }
      } catch (err: unknown) {
        setError(axios.isAxiosError(err) ? err.response?.data?.message || t('sharePage.fileNotFound') : t('sharePage.fileNotFound'));
      }
    };
    fetchFileInfo();

    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      clearStreamCookie().catch(() => { });
    };
  }, [token, setupStream, t]);

  const handleDownload = async () => {
    if (!fileInfo) return;
    setIsDownloading(true);
    try {
      const { url } = await requestShareDownloadToken(token);
      toast(t('dashboard.downloadStarted'), { icon: '⬇️', duration: 2000 });
      const link = document.createElement('a');
      link.href = API_URL + url;
      link.setAttribute('download', fileInfo.filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        const resetTime = formatBandwidthResetTime(err.response.headers?.['x-bandwidth-reset']);
        toast.error(resetTime
          ? t('sharePage.bandwidthExceededAt', { time: resetTime })
          : t('sharePage.bandwidthExceeded'));
      } else {
        toast.error(t('sharePage.downloadError'));
      }
    } finally {
      setTimeout(() => setIsDownloading(false), 2000);
    }
  };

  const showPreview = fileInfo && isPreviewable(fileInfo.mimeType);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <GuestLanguageSwitcher />
      <div className={`w-full ${showPreview ? 'max-w-4xl' : 'max-w-md'} bg-white shadow-xl rounded-2xl overflow-hidden transition-all duration-300`}>
        <div className="bg-slate-900 text-white p-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Tele-Drive</h1>
          <p className="text-slate-400 text-sm mt-1">{t('sharePage.publicFile')}</p>
        </div>

        {error ? (
          <div className="p-8 flex flex-col items-center text-center">
            <div className="w-16 h-16 bg-red-100 text-red-500 rounded-full flex items-center justify-center mb-4">
              <AlertCircle size={32} />
            </div>
            <h2 className="text-xl font-semibold text-gray-800 mb-2">{t('sharePage.cannotAccess')}</h2>
            <p className="text-gray-500">{error}</p>
          </div>
        ) : !fileInfo ? (
          <div className="p-8 flex flex-col items-center text-center">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500 mb-4" />
            <div className="text-gray-500">{t('sharePage.loading')}</div>
          </div>
        ) : (
          <div className={showPreview ? "flex flex-col md:flex-row" : "p-8 flex flex-col items-center text-center"}>

            {showPreview && (
              <div className="w-full md:w-2/3 h-[50vh] md:h-[60vh] bg-gray-100 border-b md:border-b-0 md:border-r border-gray-200 relative overflow-hidden">
                {streamUrl ? (
                  <PreviewRenderer
                    streamUrl={streamUrl}
                    onDownload={handleDownload}
                    fileInfo={fileInfo}
                    t={t}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
                  </div>
                )}
              </div>
            )}

            <div className={`p-8 flex flex-col items-center text-center w-full ${showPreview ? 'md:w-1/3 justify-center' : ''}`}>
              {!showPreview && (
                <div className="w-20 h-20 bg-blue-50 text-blue-500 rounded-2xl flex items-center justify-center mb-6 shadow-inner border border-blue-100">
                  <FileText size={40} />
                </div>
              )}

              <h2 className="text-xl font-semibold text-gray-800 mb-1 break-all line-clamp-2" title={fileInfo.filename}>
                {fileInfo.filename}
              </h2>

              <div className="text-sm text-gray-500 space-y-1 mb-8 mt-4">
                <p>{t('sharePage.fileSize')}: <span className="font-medium text-gray-700">{formatSize(Number(fileInfo.size))}</span></p>
                <p>{t('sharePage.sharedBy')}: <span className="font-medium text-gray-700">{fileInfo.user?.username || t('sharePage.anonymous')}</span></p>
                <p>{t('sharePage.createdDate')}: <span className="font-medium text-gray-700">{new Date(fileInfo.createdAt).toLocaleDateString()}</span></p>
              </div>

              <button
                onClick={handleDownload}
                disabled={isDownloading}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium py-3 rounded-xl shadow-md shadow-blue-500/20 transition-all flex items-center justify-center gap-2"
              >
                <Download size={20} />
                {isDownloading ? t('sharePage.downloading') : t('sharePage.downloadFile')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
