'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-context';
import axios from 'axios';
import { FileIcon, Download, ArrowLeft, Loader2, FileText, Film, Image as ImageIcon, Music } from 'lucide-react';

const API_URL = 'http://localhost:3001';

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
  const { token, isLoading: authLoading } = useAuth();
  
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!token) {
      router.push('/login');
      return;
    }

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
  }, [fileId, token, authLoading, router]);

  if (isLoading || authLoading) {
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
          <h2 className="mb-2 text-xl font-semibold">Error Loading Preview</h2>
          <p className="mb-6 text-gray-600">{error || 'File not found'}</p>
          <button
            onClick={() => router.back()}
            className="rounded bg-blue-500 px-4 py-2 font-semibold text-white hover:bg-blue-600 transition-colors"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  const streamUrl = `${API_URL}/files/${fileId}/stream?token=${token}`;
  const downloadUrl = `${API_URL}/files/${fileId}/download?token=${token}`;

  const renderPreview = () => {
    const { mimeType } = fileInfo;

    if (mimeType.startsWith('image/')) {
      return (
        <div className="flex h-full items-center justify-center p-4">
          <img
            src={streamUrl}
            alt={fileInfo.filename}
            className="max-h-full max-w-full rounded-lg object-contain shadow-lg"
          />
        </div>
      );
    }

    if (mimeType.startsWith('video/')) {
      return (
        <div className="flex h-full items-center justify-center p-4 bg-black">
          <video
            controls
            autoPlay
            src={streamUrl}
            className="max-h-full max-w-full rounded-lg outline-none"
          >
            Your browser does not support the video tag.
          </video>
        </div>
      );
    }

    if (mimeType.startsWith('audio/')) {
      return (
        <div className="flex h-full flex-col items-center justify-center p-4 bg-gray-100 dark:bg-gray-800">
          <Music className="mb-8 h-32 w-32 text-gray-400" />
          <audio controls src={streamUrl} className="w-full max-w-xl outline-none">
            Your browser does not support the audio tag.
          </audio>
        </div>
      );
    }

    if (mimeType === 'application/pdf') {
      return (
        <iframe
          src={streamUrl}
          className="h-full w-full border-0"
          title={fileInfo.filename}
        />
      );
    }

    if (mimeType.startsWith('text/')) {
      // For text we can either fetch or use iframe. Iframe is simpler for raw preview.
      return (
        <div className="h-full w-full bg-white p-4 overflow-hidden">
          <iframe
            src={streamUrl}
            className="h-full w-full border border-gray-200 rounded"
            title={fileInfo.filename}
          />
        </div>
      );
    }

    // Fallback for unsupported types
    return (
      <div className="flex h-full flex-col items-center justify-center bg-gray-50">
        <FileIcon className="mb-4 h-24 w-24 text-gray-400" />
        <h3 className="mb-2 text-xl font-medium text-gray-800">Preview Not Available</h3>
        <p className="mb-6 text-gray-500">This file type ({mimeType}) cannot be previewed in the browser.</p>
        <a
          href={downloadUrl}
          download={fileInfo.filename}
          className="flex items-center gap-2 rounded bg-blue-500 px-6 py-3 font-semibold text-white shadow hover:bg-blue-600 transition-colors"
        >
          <Download className="h-5 w-5" />
          Download File
        </a>
      </div>
    );
  };

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
            title="Go Back"
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
            <span className="hidden sm:inline-block">Download</span>
          </a>
        </div>
      </header>

      {/* Main Preview Area */}
      <main className="flex-1 relative overflow-hidden bg-gray-100 dark:bg-gray-900">
        {renderPreview()}
      </main>
    </div>
  );
}
