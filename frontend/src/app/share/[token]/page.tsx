'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { Download, FileText, AlertCircle, Loader2, UserCircle2 } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import { useAuth } from '@/components/auth-context';
import GuestLanguageSwitcher from '@/components/guest-language-switcher';
import toast from 'react-hot-toast';
import dynamic from 'next/dynamic';

import { API_URL, api, formatSize, requestShareDownloadToken, parseBandwidthError, getShareStreamUrl, getApiErrorMessage } from '@/lib/api';
import { useGuestStream } from '@/hooks/use-stream';
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
  const { user } = useAuth();

  const [fileInfo, setFileInfo] = useState<SharedFileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  const { streamUrl, isLoading: isStreamLoading, setupStream, teardownStream } = useGuestStream();

  useEffect(() => {
    if (!token) return;
    const fetchFileInfo = async () => {
      try {
        const res = await api.get(`files/share/${token}`);
        const info = res.data;
        setFileInfo(info);
        if (isPreviewable(info.mimeType)) {
          await setupStream(getShareStreamUrl(token));
        }
      } catch (err: unknown) {
        setError(getApiErrorMessage(err, t('sharePage.fileNotFound')));
      }
    };
    fetchFileInfo();

    return () => {
      teardownStream();
    };
  }, [token, setupStream, teardownStream, t]);

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
      const bw = parseBandwidthError(err);
      if (bw) {
        toast.error(bw.resetTime
          ? t('sharePage.bandwidthExceededAt', { time: bw.resetTime })
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
        <div className="bg-slate-900 text-white p-6">
          <div className="flex items-center justify-between">
            <div className="text-center flex-1">
              <h1 className="text-2xl font-bold tracking-tight">Tele-Drive</h1>
              <p className="text-slate-400 text-sm mt-1">{t('sharePage.publicFile')}</p>
            </div>
            {user && (
              <div className="flex items-center gap-2 text-slate-300 text-sm bg-slate-800 px-3 py-2 rounded-lg">
                <UserCircle2 size={16} />
                <span className="font-medium">{user.username}</span>
              </div>
            )}
          </div>
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
                {isStreamLoading ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
                  </div>
                ) : streamUrl ? (
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
