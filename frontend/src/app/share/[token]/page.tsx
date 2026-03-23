'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import axios from 'axios';
import { Download, FileText, AlertCircle } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import GuestLanguageSwitcher from '@/components/guest-language-switcher';

const API_URL = 'http://localhost:3001';

export default function SharePage() {
  const params = useParams();
  const token = params.token as string;
  const { t } = useI18n();

  const [fileInfo, setFileInfo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  useEffect(() => {
    if (!token) return;
    const fetchFileInfo = async () => {
      try {
        const res = await axios.get(`${API_URL}/files/share/${token}`);
        setFileInfo(res.data);
      } catch (err: any) {
        setError(err.response?.data?.message || t('sharePage.fileNotFound'));
      }
    };
    fetchFileInfo();
  }, [token]);

  const handleDownload = async () => {
    if (!fileInfo) return;
    setIsDownloading(true);
    try {
      const res = await axios.get(`${API_URL}/files/share/${token}/download`, {
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', fileInfo.filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      if (err?.response?.status === 429) {
        alert(t('sharePage.bandwidthExceeded'));
      } else {
        alert(t('sharePage.downloadError'));
      }
    } finally {
      setIsDownloading(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <GuestLanguageSwitcher />
      <div className="w-full max-w-md bg-white shadow-xl rounded-2xl overflow-hidden">
        <div className="bg-slate-900 text-white p-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Tele-Drive</h1>
          <p className="text-slate-400 text-sm mt-1">{t('sharePage.publicFile')}</p>
        </div>
        
        <div className="p-8 flex flex-col items-center text-center">
          {error ? (
            <div className="flex flex-col items-center">
              <div className="w-16 h-16 bg-red-100 text-red-500 rounded-full flex items-center justify-center mb-4">
                <AlertCircle size={32} />
              </div>
              <h2 className="text-xl font-semibold text-gray-800 mb-2">{t('sharePage.cannotAccess')}</h2>
              <p className="text-gray-500">{error}</p>
            </div>
          ) : !fileInfo ? (
            <div className="text-gray-500">{t('sharePage.loading')}</div>
          ) : (
            <div className="flex flex-col items-center w-full">
              <div className="w-20 h-20 bg-blue-50 text-blue-500 rounded-2xl flex items-center justify-center mb-6 shadow-inner border border-blue-100">
                <FileText size={40} />
              </div>
              
              <h2 className="text-xl font-semibold text-gray-800 mb-1 break-all line-clamp-2" title={fileInfo.filename}>
                {fileInfo.filename}
              </h2>
              
              <div className="text-sm text-gray-500 space-y-1 mb-8">
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
          )}
        </div>
      </div>
    </div>
  );
}
