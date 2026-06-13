'use client';

import { Download, FileIcon } from 'lucide-react';
import PreviewCodeViewer from '@/components/preview/preview-code-viewer';
import { PreviewVideo, PreviewAudio } from '@/components/preview/preview-media-viewer';
import { PreviewPdf } from '@/components/preview/preview-pdf-viewer';

interface PreviewRendererProps {
  streamUrl: string;
  onDownload: () => void;
  fileInfo: { filename: string; mimeType: string; size: number };
  t: (key: string, params?: Record<string, string | number>) => string;
}

export default function PreviewRenderer({ streamUrl, onDownload, fileInfo, t }: PreviewRendererProps) {
  const { mimeType, filename } = fileInfo;

  if (mimeType.startsWith('image/')) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={streamUrl}
          alt={filename}
          crossOrigin="use-credentials"
          className="max-h-full max-w-full rounded-lg object-contain shadow-lg"
        />
      </div>
    );
  }

  if (mimeType.startsWith('video/')) return <PreviewVideo src={streamUrl} />;
  if (mimeType.startsWith('audio/')) return <PreviewAudio src={streamUrl} />;
  if (mimeType === 'application/pdf') return <PreviewPdf url={streamUrl} />;

  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') {
    return <PreviewCodeViewer url={streamUrl} filename={filename} />;
  }

  return (
    <div className="flex h-full flex-col items-center justify-center bg-gray-50">
      <FileIcon className="mb-4 h-24 w-24 text-gray-400" />
      <h3 className="mb-2 text-xl font-medium text-gray-800">{t('preview.notAvailable')}</h3>
      <p className="mb-6 text-gray-500">{t('preview.cannotPreview', { mimeType })}</p>
      <button
        onClick={onDownload}
        className="flex items-center gap-2 rounded bg-blue-500 px-6 py-3 font-semibold text-white shadow hover:bg-blue-600 transition-colors"
      >
        <Download className="h-5 w-5" />
        {t('preview.downloadFile')}
      </button>
    </div>
  );
}
