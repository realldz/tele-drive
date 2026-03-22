'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import axios from 'axios';
import { Download, FileText, AlertCircle, Folder, ChevronRight, Home } from 'lucide-react';

const API_URL = 'http://localhost:3001';

export default function SharedFolderPage() {
  const params = useParams();
  const token = params.token as string;

  const [rootFolder, setRootFolder] = useState<any>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>(undefined);
  const [folders, setFolders] = useState<any[]>([]);
  const [files, setFiles] = useState<any[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const fetchContent = useCallback(async () => {
    if (!token) return;
    setIsLoading(true);
    setError(null);
    try {
      const url = currentFolderId 
        ? `${API_URL}/folders/share/${token}?folderId=${currentFolderId}`
        : `${API_URL}/folders/share/${token}`;
      const res = await axios.get(url);
      
      setRootFolder(res.data.rootFolder);
      setFolders(res.data.folders || []);
      setFiles(res.data.files || []);
      setBreadcrumbs(res.data.breadcrumbs || []);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Thư mục không tồn tại hoặc đã ngừng chia sẻ');
    } finally {
      setIsLoading(false);
    }
  }, [token, currentFolderId]);

  useEffect(() => {
    fetchContent();
  }, [fetchContent]);

  const handleDownload = async (file: any) => {
    setDownloadingId(file.id);
    try {
      const res = await axios.get(`${API_URL}/folders/share/${token}/download/${file.id}`, {
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', file.filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      if (err?.response?.status === 429) {
        alert('Tập tin này đã vượt quá giới hạn băng thông hôm nay.');
      } else {
        alert('Lỗi tải tập tin');
      }
    } finally {
      setDownloadingId(null);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <div className="flex flex-col items-center bg-white p-8 rounded-2xl shadow-sm">
          <div className="w-16 h-16 bg-red-100 text-red-500 rounded-full flex items-center justify-center mb-4">
            <AlertCircle size={32} />
          </div>
          <h2 className="text-xl font-semibold text-gray-800 mb-2">Không thể truy cập</h2>
          <p className="text-gray-500">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-5xl mx-auto bg-white shadow-sm rounded-2xl overflow-hidden border border-gray-100">
        <div className="bg-slate-900 justify-between items-center text-white p-6 flex">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Tele-Drive</h1>
            <p className="text-slate-400 text-sm mt-1">
              Thư mục chia sẻ bởi: <span className="text-slate-200">{rootFolder?.user?.username || 'Người dùng'}</span>
            </p>
          </div>
        </div>

        <div className="p-6">
          {/* Breadcrumbs */}
          <div className="flex items-center text-sm text-gray-600 mb-6 bg-gray-50 px-4 py-3 rounded-xl overflow-x-auto">
            <button 
              onClick={() => setCurrentFolderId(undefined)}
              className="hover:text-blue-600 transition-colors flex items-center gap-1 font-medium whitespace-nowrap"
            >
              <Home size={16} /> Trang chủ chia sẻ
            </button>
            
            {breadcrumbs.map((crumb, index) => (
              <div key={crumb.id} className="flex items-center whitespace-nowrap">
                <ChevronRight size={16} className="mx-1 text-gray-400" />
                <button
                  onClick={() => setCurrentFolderId(crumb.id)}
                  className={`hover:text-blue-600 transition-colors ${
                    index === breadcrumbs.length - 1 ? 'text-gray-900 font-semibold' : 'font-medium'
                  }`}
                >
                  {crumb.name}
                </button>
              </div>
            ))}
          </div>

          {isLoading ? (
            <div className="text-center py-12 text-gray-500">Đang tải dữ liệu...</div>
          ) : folders.length === 0 && files.length === 0 ? (
            <div className="text-center py-16 bg-gray-50 rounded-xl border border-dashed border-gray-200">
              <Folder size={48} className="mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500">Thư mục này trống</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {/* Folders */}
              {folders.map(folder => (
                <div 
                  key={folder.id} 
                  onClick={() => setCurrentFolderId(folder.id)}
                  className="bg-white border border-gray-100 p-4 rounded-xl flex items-center hover:shadow-md hover:border-blue-100 transition-all cursor-pointer group"
                >
                  <div className="w-10 h-10 bg-blue-50 text-blue-500 rounded-lg flex items-center justify-center mr-3 group-hover:bg-blue-100 transition-colors">
                    <Folder size={20} className="fill-current opacity-20" />
                  </div>
                  <span className="font-medium text-gray-800 truncate" title={folder.name}>
                    {folder.name}
                  </span>
                </div>
              ))}

              {/* Files */}
              {files.map(file => (
                <div 
                  key={file.id} 
                  className="bg-white border border-gray-100 p-4 rounded-xl flex items-start hover:shadow-md transition-all group"
                >
                  <div className="flex-1 overflow-hidden pr-2">
                    <div className="flex items-start mb-2">
                      <FileText className="w-8 h-8 text-gray-400 mr-2 flex-shrink-0" />
                      <div className="overflow-hidden">
                        <span className="font-medium text-gray-800 text-sm break-all line-clamp-2" title={file.filename}>
                          {file.filename}
                        </span>
                        <span className="text-xs text-gray-500 mt-1 block">{formatSize(Number(file.size))}</span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDownload(file)}
                    disabled={downloadingId === file.id}
                    className="p-2 text-blue-600 bg-blue-50 hover:bg-blue-600 hover:text-white rounded-lg transition-colors flex-shrink-0 disabled:opacity-50"
                    title="Tải xuống"
                  >
                    <Download size={18} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
