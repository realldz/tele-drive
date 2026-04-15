'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useI18n } from '@/components/i18n-context';
import { useRequireAuth } from '@/hooks/use-require-auth';
import { FileIcon, Download, ArrowLeft, Loader2 } from 'lucide-react';
import { getFileIcon } from '@/lib/file-icon';
import { API_URL, api, requestDownloadToken, parseBandwidthError, getStreamUrl, getApiErrorMessage } from '@/lib/api';
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

export default function FilePreviewPage() {
  const params = useParams();
  const fileId = params.id as string;
  const router = useRouter();
  const { isReady } = useRequireAuth();
  const { t } = useI18n();

  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { streamUrl, isLoading: isStreamLoading, setupStream, teardownStream } = useStream();

  useEffect(() => {
    if (!isReady) return;

    setIsLoading(true);
    setError(null);

    api.get(`/files/${fileId}/info`)
      .then(async (res) => {
        setFileInfo(res.data);
        await setupStream(getStreamUrl(fileId));
      })
      .catch((err: unknown) => {
        setError(getApiErrorMessage(err, 'Failed to load file information'));
      })
      .finally(() => setIsLoading(false));

    return () => {
      teardownStream();
    };
  }, [fileId, isReady, setupStream, teardownStream]);

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

  if (isLoading || !isReady) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (error || !fileInfo) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-gray-50 p-4">
        <div className="rounded-lg bg-white p-8 text-center shadow-md">
          <FileIcon className="mx-auto mb-4 h-16 w-16 text-red-400" />
          <h2 className="mb-2 text-xl font-semibold">{t('preview.errorTitle')}</h2>
          <p className="mb-6 text-gray-600">{error || t('preview.fileNotFound')}</p>
          <button
            onClick={() => router.back()}
            className="rounded bg-blue-500 px-4 py-2 font-semibold text-white hover:bg-blue-600 transition-colors"
          >
            {t('preview.goBack')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-gray-50 dark:bg-gray-900 overflow-hidden">
      <header className="flex h-16 items-center justify-between border-b bg-white px-4 py-3 shadow-sm dark:border-gray-800 dark:bg-gray-950 flex-none z-10">
        <div className="flex items-center gap-4 min-w-0">
          <button
            onClick={() => router.back()}
            className="rounded-full p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title={t('preview.goBack')}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          <div className="flex items-center gap-3 min-w-0">
            {getFileIcon(fileInfo.mimeType, 'h-5 w-5 text-gray-500')}
            <h1 className="truncate font-semibold text-gray-800 dark:text-gray-100">
              {fileInfo.filename}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-4 flex-none ml-4">
          <span className="text-sm text-gray-500 hidden sm:inline-block">
            {(fileInfo.size / (1024 * 1024)).toFixed(2)} MB
          </span>
          <button
            onClick={handleDownload}
            className="flex items-center gap-2 rounded-md bg-transparent px-3 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline-block">{t('preview.download')}</span>
          </button>
        </div>
      </header>

      <main className="flex-1 relative overflow-hidden bg-gray-100 dark:bg-gray-900">
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
      </main>
    </div>
  );
}
