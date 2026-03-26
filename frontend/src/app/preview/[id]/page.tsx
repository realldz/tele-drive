'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useI18n } from '@/components/i18n-context';
import { useRequireAuth } from '@/hooks/use-require-auth';
import axios from 'axios';
import { FileIcon, Download, ArrowLeft, Loader2, FileText, Film, Image as ImageIcon, Music } from 'lucide-react';

import { API_URL } from '@/lib/api';
import dynamic from 'next/dynamic';

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
  const { isReady, token } = useRequireAuth();
  const { t } = useI18n();

  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isReady) return;

    const fetchFileInfo = async () => {
      try {
        const res = await axios.get(`${API_URL}/files/${fileId}/info`);
        setFileInfo(res.data);
      } catch (err: any) {
        setError(err.response?.data?.message || 'Failed to load file information');
      } finally {
        setIsLoading(false);
      }
    };

    fetchFileInfo();
  }, [fileId, isReady]);

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

  const streamUrl = `${API_URL}/files/${fileId}/stream?token=${token}`;
  const downloadUrl = `${API_URL}/files/${fileId}/download?token=${token}`;

  const getFileIcon = (mimeType: string) => {
    if (mimeType.startsWith('image/')) return <ImageIcon className="h-5 w-5 text-gray-500" />;
    if (mimeType.startsWith('video/')) return <Film className="h-5 w-5 text-gray-500" />;
    if (mimeType.startsWith('audio/')) return <Music className="h-5 w-5 text-gray-500" />;
    if (mimeType.startsWith('text/')) return <FileText className="h-5 w-5 text-gray-500" />;
    return <FileIcon className="h-5 w-5 text-gray-500" />;
  };

  return (
    <div className="flex h-screen flex-col bg-gray-50 dark:bg-gray-900 overflow-hidden">
      {/* Top Navigation Bar */}
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
            {getFileIcon(fileInfo.mimeType)}
            <h1 className="truncate font-semibold text-gray-800 dark:text-gray-100">
              {fileInfo.filename}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-4 flex-none ml-4">
          <span className="text-sm text-gray-500 hidden sm:inline-block">
            {(fileInfo.size / (1024 * 1024)).toFixed(2)} MB
          </span>
          <a
            href={downloadUrl}
            download={fileInfo.filename}
            className="flex items-center gap-2 rounded-md bg-transparent px-3 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline-block">{t('preview.download')}</span>
          </a>
        </div>
      </header>

      {/* Main Preview Area */}
      <main className="flex-1 relative overflow-hidden bg-gray-100 dark:bg-gray-900">
        <PreviewRenderer
          streamUrl={streamUrl}
          downloadUrl={downloadUrl}
          fileInfo={fileInfo}
          t={t}
        />
      </main>
    </div>
  );
}
