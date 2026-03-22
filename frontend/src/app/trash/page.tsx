'use client';

import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { FileText, Folder, Trash2, RotateCcw, ArrowLeft, Clock, Menu, X, FolderPlus, Home, ShieldAlert, User, LogOut, HardDrive } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-context';

const API_URL = 'http://localhost:3001';

interface QuotaInfo {
  usedSpace: number;
  quota: number;
}

export default function TrashPage() {
  const { user, token, isLoading, logout } = useAuth();
  const router = useRouter();

  const [trashedFiles, setTrashedFiles] = useState<any[]>([]);
  const [trashedFolders, setTrashedFolders] = useState<any[]>([]);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [quotaInfo, setQuotaInfo] = useState<QuotaInfo | null>(null);

  useEffect(() => {
    if (!isLoading && !token) {
      router.push('/login');
    }
  }, [isLoading, token, router]);

  const fetchQuota = useCallback(async () => {
    if (!token) return;
    try {
      const res = await axios.get(`${API_URL}/users/me`);
      setQuotaInfo({
        usedSpace: Number(res.data.usedSpace),
        quota: Number(res.data.quota),
      });
    } catch (error) {
      // ignore
    }
  }, [token]);

  const fetchTrash = useCallback(async () => {
    if (!token) return;
    try {
      const [filesRes, foldersRes] = await Promise.all([
        axios.get(`${API_URL}/files/trash/list`),
        axios.get(`${API_URL}/folders/trash/list`),
      ]);
      setTrashedFiles(filesRes.data);
      setTrashedFolders(foldersRes.data);
    } catch (error: any) {
      if (error?.response?.status === 401) {
        logout();
        router.push('/login');
      }
    }
  }, [token, logout, router]);

  useEffect(() => {
    fetchTrash();
    fetchQuota();
  }, [fetchTrash, fetchQuota]);

  const handleRestoreFile = async (id: string) => {
    try {
      await axios.patch(`${API_URL}/files/${id}/restore`);
      fetchTrash();
    } catch (error: any) {
      alert(error?.response?.data?.message || 'Error restoring file');
    }
  };

  const handlePermanentDeleteFile = async (id: string) => {
    if (!confirm('Xoá vĩnh viễn file này? Hành động này không thể hoàn tác.')) return;
    try {
      await axios.delete(`${API_URL}/files/${id}/permanent`);
      fetchTrash();
    } catch (error: any) {
      alert(error?.response?.data?.message || 'Error deleting file');
    }
  };

  const handleRestoreFolder = async (id: string) => {
    try {
      await axios.patch(`${API_URL}/folders/${id}/restore`);
      fetchTrash();
    } catch (error: any) {
      alert(error?.response?.data?.message || 'Error restoring folder');
    }
  };

  const handlePermanentDeleteFolder = async (id: string) => {
    if (!confirm('Xoá vĩnh viễn thư mục này và toàn bộ nội dung? Hành động này không thể hoàn tác.')) return;
    try {
      await axios.delete(`${API_URL}/folders/${id}/permanent`);
      fetchTrash();
    } catch (error: any) {
      alert(error?.response?.data?.message || 'Error deleting folder');
    }
  };

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!token) return null;

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  const getDaysRemaining = (deletedAt: string) => {
    const deleted = new Date(deletedAt);
    const expiry = new Date(deleted.getTime() + 7 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const remaining = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return Math.max(0, remaining);
  };

  const totalItems = trashedFiles.length + trashedFolders.length;
  const quotaPercentage = quotaInfo ? Math.min((quotaInfo.usedSpace / quotaInfo.quota) * 100, 100) : 0;

  return (
    <div className="h-screen bg-white flex overflow-hidden">
      
      {/* Mobile Sidebar Overlay */}
      {isMobileSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-20 md:hidden"
          onClick={() => setIsMobileSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`fixed md:static inset-y-0 left-0 w-64 bg-slate-900 border-r border-slate-800 flex flex-col transition-transform duration-300 z-30 ${isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="p-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            Tele-Drive
          </h1>
          <button className="md:hidden text-slate-400 hover:text-white" onClick={() => setIsMobileSidebarOpen(false)}>
            <X size={24} />
          </button>
        </div>

        <nav className="flex-1 px-4 space-y-2 overflow-y-auto mt-6">
          <button onClick={() => { router.push('/'); setIsMobileSidebarOpen(false); }} className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium hover:bg-white/5 text-slate-300 transition-colors">
            <Home size={20} /> Trang chủ
          </button>
          <button onClick={() => { setIsMobileSidebarOpen(false); }} className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium bg-white/10 text-white transition-colors">
            <Trash2 size={20} /> Thùng rác
          </button>
          
          {user?.role === 'ADMIN' && (
            <>
              <div className="pt-4 mt-4 border-t border-slate-800"></div>
              <button 
                onClick={() => router.push('/admin')}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium hover:bg-white/5 text-amber-400 transition-colors"
              >
                <ShieldAlert size={20} /> Admin Panel
              </button>
            </>
          )}
        </nav>

        <div className="p-4 border-t border-slate-800">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center flex-shrink-0">
              <User size={20} className="text-slate-400" />
            </div>
            <div className="overflow-hidden">
              <p className="font-medium text-white truncate text-sm">{user?.username}</p>
              <button onClick={handleLogout} className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1 mt-1">
                <LogOut size={12} /> Đăng xuất
              </button>
            </div>
          </div>
          {quotaInfo && (
            <div className="bg-slate-800 rounded-lg p-3">
              <div className="flex justify-between items-center mb-2 text-xs text-slate-300">
                <span className="flex items-center gap-1"><HardDrive size={12} /> Đã dùng</span>
                <span>{quotaPercentage.toFixed(1)}%</span>
              </div>
              <div className="w-full bg-slate-700 rounded-full h-1.5 mb-2">
                <div
                  className={`h-1.5 rounded-full transition-all ${quotaPercentage > 90 ? 'bg-red-500' : 'bg-blue-500'}`}
                  style={{ width: `${quotaPercentage}%` }}
                />
              </div>
              <div className="text-[10px] text-slate-400 text-center font-medium">
                {formatSize(quotaInfo.usedSpace)} / {formatSize(quotaInfo.quota)}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* Main Area */}
      <main className="flex-1 flex flex-col min-w-0 bg-white relative">
        
        {/* Topbar */}
        <header className="h-16 border-b border-gray-100 flex items-center justify-between px-4 lg:px-6 bg-white w-full flex-shrink-0 z-10">
          <div className="flex items-center gap-4">
            <button className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-lg md:hidden" onClick={() => setIsMobileSidebarOpen(true)}>
              <Menu size={24} />
            </button>
            <h2 className="text-xl font-bold flex items-center gap-2 text-gray-800">
              <Trash2 className="text-red-500" size={24} />
              Thùng rác
            </h2>
          </div>
          <div className="text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1.5 rounded-full">
            {totalItems} mục
          </div>
        </header>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto">
          {/* Info banner */}
          <div className="bg-amber-50 px-6 py-3 border-b border-amber-200 text-sm text-amber-800 flex items-center gap-2">
            <Clock size={16} />
            Các mục trong thùng rác sẽ bị xoá vĩnh viễn sau 7 ngày.
          </div>

          <div className="p-6">
            {totalItems === 0 ? (
              <div className="text-center py-20 bg-gray-50 rounded-2xl border-2 border-dashed border-gray-200 mt-4">
                <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mx-auto mb-4 shadow-sm border border-gray-100">
                  <Trash2 className="text-gray-300" size={32} />
                </div>
                <p className="text-gray-500 font-medium tracking-wide">Thùng rác đang trống</p>
              </div>
            ) : (
              <div className="space-y-8">
                {/* Folders */}
                {trashedFolders.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">Thư mục</h3>
                    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
                      <table className="w-full text-left border-collapse">
                        <tbody className="divide-y divide-gray-100">
                          {trashedFolders.map(folder => (
                            <tr key={folder.id} className="hover:bg-gray-50 transition-colors">
                              <td className="p-4 flex items-center gap-3">
                                <Folder className="w-6 h-6 text-gray-400 flex-shrink-0" fill="currentColor" opacity={0.5} />
                                <div>
                                  <span className="font-medium text-gray-800 block">{folder.name}</span>
                                  <span className="text-xs text-red-500 mt-0.5 block flex items-center gap-1">
                                    <Clock size={10} /> {getDaysRemaining(folder.deletedAt)} ngày còn lại
                                  </span>
                                </div>
                              </td>
                              <td className="p-4 text-right">
                                <div className="flex justify-end gap-2">
                                  <button
                                    onClick={() => handleRestoreFolder(folder.id)}
                                    className="p-2 text-green-600 bg-green-50 hover:bg-green-100 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
                                  >
                                    <RotateCcw size={16} /> <span className="hidden sm:inline">Khôi phục</span>
                                  </button>
                                  <button
                                    onClick={() => handlePermanentDeleteFolder(folder.id)}
                                    className="p-2 text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
                                  >
                                    <Trash2 size={16} /> <span className="hidden sm:inline">Xoá vĩnh viễn</span>
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Files */}
                {trashedFiles.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">Tập tin</h3>
                    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
                      <table className="w-full text-left border-collapse">
                        <tbody className="divide-y divide-gray-100">
                          {trashedFiles.map(file => (
                            <tr key={file.id} className="hover:bg-gray-50 transition-colors">
                              <td className="p-4 flex items-center gap-3">
                                <FileText className="w-6 h-6 text-gray-400 flex-shrink-0" />
                                <div>
                                  <span className="font-medium text-gray-800 block truncate max-w-[200px] sm:max-w-xs">{file.filename}</span>
                                  <div className="text-xs mt-0.5 flex flex-wrap items-center gap-2">
                                    <span className="text-gray-500 font-medium bg-gray-100 px-1.5 py-0.5 rounded">{formatSize(Number(file.size))}</span>
                                    <span className="text-red-500 flex items-center gap-1">
                                      <Clock size={10} /> {getDaysRemaining(file.deletedAt)} ngày còn lại
                                    </span>
                                  </div>
                                </div>
                              </td>
                              <td className="p-4 text-right whitespace-nowrap">
                                <div className="flex justify-end gap-2">
                                  <button
                                    onClick={() => handleRestoreFile(file.id)}
                                    className="p-2 text-green-600 bg-green-50 hover:bg-green-100 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
                                  >
                                    <RotateCcw size={16} /> <span className="hidden sm:inline">Khôi phục</span>
                                  </button>
                                  <button
                                    onClick={() => handlePermanentDeleteFile(file.id)}
                                    className="p-2 text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
                                  >
                                    <Trash2 size={16} /> <span className="hidden sm:inline">Xoá vĩnh viễn</span>
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
