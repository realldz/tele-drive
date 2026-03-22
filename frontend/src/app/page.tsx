'use client';

import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Folder, FileText, Home, ChevronRight, Download, Trash2, FolderPlus, LogOut, User, HardDrive, MoreVertical, Edit2, Move, Share2, Loader2, Search, LayoutGrid, List, Menu, X, ShieldAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-context';
import UploadZone from '@/components/upload-zone';
import RenameDialog from '@/components/rename-dialog';
import ShareDialog from '@/components/share-dialog';
import MoveDialog from '@/components/move-dialog';
import toast from 'react-hot-toast';

const API_URL = 'http://localhost:3001';

interface QuotaInfo {
  usedSpace: number;
  quota: number;
}

export default function Dashboard() {
  const { user, token, isLoading, logout } = useAuth();
  const router = useRouter();

  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>(undefined);
  const [folders, setFolders] = useState<any[]>([]);
  const [files, setFiles] = useState<any[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<any[]>([]);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [quotaInfo, setQuotaInfo] = useState<QuotaInfo | null>(null);
  const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(new Set());

  // UI Polish States
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  const filteredFolders = folders.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()));
  const filteredFiles = files.filter(f => f.filename.toLowerCase().includes(searchQuery.toLowerCase()));

  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean;
    x: number;
    y: number;
    item: any;
    type: 'file' | 'folder';
  }>({ isOpen: false, x: 0, y: 0, item: null, type: 'file' });

  const [activeDialog, setActiveDialog] = useState<'rename' | 'move' | 'share' | 'none'>('none');
  const [dialogItem, setDialogItem] = useState<any>(null);
  const [dialogItemType, setDialogItemType] = useState<'file' | 'folder'>('file');

  // Drag and Drop state
  const [draggedItem, setDraggedItem] = useState<{ id: string; type: 'file' | 'folder' } | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);

  useEffect(() => {
    const handleClickOutside = () => setContextMenu(prev => ({ ...prev, isOpen: false }));
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  // Redirect nếu chưa đăng nhập
  useEffect(() => {
    if (!isLoading && !token) {
      router.push('/login');
    }
  }, [isLoading, token, router]);

  // Fetch quota info
  const fetchQuota = useCallback(async () => {
    if (!token) return;
    try {
      const res = await axios.get(`${API_URL}/users/me`);
      setQuotaInfo({
        usedSpace: Number(res.data.usedSpace),
        quota: Number(res.data.quota),
      });
    } catch (error) {
      // Quota info is non-critical, silently fail
    }
  }, [token]);

  const fetchContent = useCallback(async () => {
    if (!token) return;
    try {
      const url = currentFolderId ? `${API_URL}/folders/content?folderId=${currentFolderId}` : `${API_URL}/folders/content`;
      const res = await axios.get(url);
      setFolders(res.data.folders);
      setFiles(res.data.files);

      if (currentFolderId) {
        const bcRes = await axios.get(`${API_URL}/folders/${currentFolderId}/breadcrumbs`);
        setBreadcrumbs(bcRes.data);
      } else {
        setBreadcrumbs([]);
      }
    } catch (error: any) {
      // Nếu 401, redirect về login
      if (error?.response?.status === 401) {
        logout();
        router.push('/login');
        return;
      }
    }
  }, [currentFolderId, token, logout, router]);

  useEffect(() => {
    fetchContent();
    fetchQuota();
  }, [fetchContent, fetchQuota]);

  // Polling fetchContent if there are files currently uploading on the server
  useEffect(() => {
    const hasUploadingFiles = files.some(f => f.status === 'uploading');
    if (hasUploadingFiles && !searchQuery) {
      const intervalId = setInterval(() => {
        fetchContent();
      }, 3000); // 3 seconds
      return () => clearInterval(intervalId);
    }
  }, [files, fetchContent, searchQuery]);

  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || isCreatingFolder) return;
    setIsCreatingFolder(true);
    try {
      await axios.post(`${API_URL}/folders`, {
        name: newFolderName,
        parentId: currentFolderId,
      });
      setNewFolderName('');
      setShowNewFolder(false);
      fetchContent();
    } catch (error: any) {
      alert(error?.response?.data?.message || 'Error creating folder');
    } finally {
      setIsCreatingFolder(false);
    }
  };

  const handleDeleteFolder = async (e: any, id: string) => {
    e.stopPropagation();
    try {
      await axios.delete(`${API_URL}/folders/${id}`);
      fetchContent();
      fetchQuota();
      toast.success(
        (t) => (
          <span className="flex items-center gap-2">
            Đã xoá thư mục
            <button
              onClick={async () => {
                toast.dismiss(t.id);
                try {
                  await axios.patch(`${API_URL}/folders/${id}/restore`, {}, {
                    headers: { Authorization: `Bearer ${token}` }
                  });
                  fetchContent();
                  fetchQuota();
                } catch(err) {
                  alert('Lỗi hoàn tác');
                }
              }}
              className="text-blue-500 font-semibold text-sm hover:underline ml-2 cursor-pointer"
            >
              Hoàn tác
            </button>
          </span>
        ),
        { duration: 5000 }
      );
    } catch (error: any) {
      alert(error?.response?.data?.message || 'Error moving folder to trash');
    }
  };

  const handleDeleteFile = async (e: any, id: string) => {
    e.stopPropagation();
    try {
      await axios.delete(`${API_URL}/files/${id}`);
      fetchContent();
      toast.success(
        (t) => (
          <span className="flex items-center gap-2">
            Đã xoá tập tin
            <button
              onClick={async () => {
                toast.dismiss(t.id);
                try {
                  await axios.patch(`${API_URL}/files/${id}/restore`, {}, {
                    headers: { Authorization: `Bearer ${token}` }
                  });
                  fetchContent();
                } catch(err) {
                  alert('Lỗi hoàn tác');
                }
              }}
              className="text-blue-500 font-semibold text-sm hover:underline ml-2 cursor-pointer"
            >
              Hoàn tác
            </button>
          </span>
        ),
        { duration: 5000 }
      );
    } catch (error: any) {
      alert(error?.response?.data?.message || 'Error moving file to trash');
    }
  };

  const handleDeleteStuckFile = async (e: any, id: string) => {
    e.stopPropagation();
    try {
      await axios.post(`${API_URL}/files/upload/${id}/abort`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      fetchContent();
      fetchQuota();
    } catch (error: any) {
      alert(error?.response?.data?.message || 'Lỗi xoá file đang kẹt');
    }
  };

  /**
   * Download file — dùng link trực tiếp với token query param để trình duyệt
   * hiện hộp thoại download ngay, không cần buffer toàn bộ file vào RAM.
   * Kiểm tra lỗi quota bằng HEAD request trước khi mở link.
   */
  const handleDownload = async (fileId: string, filename: string) => {
    setDownloadingFiles((prev) => new Set(prev).add(fileId));
    try {
      // Kiểm tra nhanh quota / quyền trước khi kích hoạt download
      await axios.head(`${API_URL}/files/${fileId}/download`);

      const downloadUrl = `${API_URL}/files/${fileId}/download?token=${token}`;
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error: any) {
      if (error?.response?.status === 429) {
        alert('Đã vượt giới hạn băng thông hàng ngày. Vui lòng thử lại vào ngày mai.');
      } else {
        alert(error?.response?.data?.message || 'Lỗi tải xuống file');
      }
    } finally {
      setDownloadingFiles((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  };

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  const handleDragStart = (e: React.DragEvent, item: any, type: 'file' | 'folder') => {
    setDraggedItem({ id: item.id, type });
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, folderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (draggedItem && draggedItem.id !== folderId) {
      setDragOverFolderId(folderId);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolderId(null);
  };

  const handleDrop = async (e: React.DragEvent, targetFolderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolderId(null);

    // Bỏ qua nếu không có item, drop vào chính nơi nó đang đứng, hoặc drop vào chính nó
    if (!draggedItem || targetFolderId === (currentFolderId || null) || draggedItem.id === targetFolderId) {
      return;
    }

    try {
      const endpoint = draggedItem.type === 'folder' ? 'folders' : 'files';
      await axios.patch(`${API_URL}/${endpoint}/${draggedItem.id}/move`, { 
        folderId: targetFolderId, 
        parentId: targetFolderId 
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      fetchContent();
    } catch (error: any) {
      alert(error.response?.data?.message || 'Lỗi di chuyển');
    }
    setDraggedItem(null);
  };

  const handleOpenDialog = (targetDialog: 'rename' | 'move' | 'share') => {
    setActiveDialog(targetDialog);
    setDialogItem(contextMenu.item);
    setDialogItemType(contextMenu.type);
    setContextMenu(prev => ({ ...prev, isOpen: false }));
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  // Chưa login (redirect sẽ xảy ra bởi useEffect)
  if (!token) return null;

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

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

        <nav className="flex-1 px-4 space-y-2 overflow-y-auto">
          <button 
            onClick={() => { setShowNewFolder(!showNewFolder); setIsMobileSidebarOpen(false); }}
            className="w-full flex items-center gap-3 bg-blue-600 hover:bg-blue-500 px-4 py-3 rounded-lg font-medium transition-colors text-white shadow-sm mb-6"
          >
            <FolderPlus size={18} /> Thư mục mới
          </button>

          <button onClick={() => { router.push('/'); setIsMobileSidebarOpen(false); }} className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium bg-white/10 text-white transition-colors">
            <Home size={20} /> Trang chủ
          </button>
          <button onClick={() => { router.push('/trash'); setIsMobileSidebarOpen(false); }} className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium hover:bg-white/5 text-slate-300 transition-colors">
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
        <header className="h-16 border-b border-gray-100 flex items-center justify-between px-4 lg:px-6 bg-white w-full flex-shrink-0 z-10 transition-shadow">
          <div className="flex items-center gap-4 flex-1">
            <button className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-lg md:hidden" onClick={() => setIsMobileSidebarOpen(true)}>
              <Menu size={24} />
            </button>
            <div className="relative max-w-xl w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
              <input 
                type="text" 
                placeholder="Tìm kiếm tệp và thư mục..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-50 rounded-xl outline-none transition-all text-sm font-medium"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 ml-4">
            <div className="hidden sm:flex bg-gray-50 p-1 rounded-lg border border-gray-200">
              <button 
                onClick={() => setViewMode('grid')}
                className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
                title="Dạng lưới"
              >
                <LayoutGrid size={18} />
              </button>
              <button 
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
                title="Dạng danh sách"
              >
                <List size={18} />
              </button>
            </div>
          </div>
        </header>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto">
          
          {/* Breadcrumbs */}
          <div 
            className="px-6 py-4 flex flex-wrap items-center gap-2 text-sm text-gray-600 font-medium border-b border-gray-50"
          >
            <button 
              onClick={() => setCurrentFolderId(undefined)}
              onDragOver={(e) => handleDragOver(e, null)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, null)}
              className={`hover:text-blue-600 flex items-center gap-1 transition-colors px-2 py-1.5 rounded-md cursor-pointer ${
                dragOverFolderId === null ? 'bg-blue-50 text-blue-700 ring-2 ring-blue-200' : 'hover:bg-gray-50'
              }`}
            >
              <Home size={16} /> Drive Của Tôi
            </button>
            
            {breadcrumbs.map((bc) => (
              <div key={bc.id} className="flex items-center gap-2">
                <ChevronRight size={16} className="text-gray-400" />
                <button 
                  onClick={() => setCurrentFolderId(bc.id)}
                  onDragOver={(e) => handleDragOver(e, bc.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, bc.id)}
                  className={`hover:text-blue-600 transition-colors px-2 py-1.5 rounded-md cursor-pointer ${
                    dragOverFolderId === bc.id ? 'bg-blue-50 text-blue-700 ring-2 ring-blue-200' : 'hover:bg-gray-50'
                  }`}
                >
                  {bc.name}
                </button>
              </div>
            ))}
          </div>

          <div className="p-6">
            
            {/* Create Folder Box */}
            {showNewFolder && (
              <div className="flex gap-2 p-4 mb-6 bg-blue-50/50 border border-blue-100 rounded-xl shadow-sm">
                <input 
                  type="text" 
                  placeholder="Tên thư mục mới..." 
                  className="border border-blue-200 p-2.5 rounded-lg flex-grow outline-none focus:ring-2 focus:ring-blue-500"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
                  autoFocus
                />
                <button onClick={handleCreateFolder} disabled={isCreatingFolder} className="bg-blue-600 text-white px-6 rounded-lg hover:bg-blue-700 font-medium transition-colors shadow-sm disabled:opacity-50">
                  {isCreatingFolder ? 'Đang tạo...' : 'Tạo'}
                </button>
                <button onClick={() => setShowNewFolder(false)} className="bg-white border border-gray-200 text-gray-700 px-6 rounded-lg hover:bg-gray-50 font-medium transition-colors">Huỷ</button>
              </div>
            )}

            {filteredFolders.length === 0 && filteredFiles.length === 0 ? (
              <div className="text-center py-20 bg-gray-50/50 rounded-2xl border-2 border-dashed border-gray-200 mt-4">
                <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mx-auto mb-4 shadow-sm border border-gray-100">
                  <Folder className="text-gray-300" size={32} />
                </div>
                {searchQuery ? (
                  <p className="text-gray-500 font-medium">Không tìm thấy nội dung nào phù hợp.</p>
                ) : (
                  <p className="text-gray-500 font-medium">Thư mục trống. Hãy kéo thả file hoặc tạo thư mục mới!</p>
                )}
              </div>
            ) : (
              <>
                {/* Folders Section */}
                {filteredFolders.length > 0 && (
                  <div className="mb-8">
                    <h2 className="text-sm font-bold text-gray-500 mb-4 uppercase tracking-wider">Thư mục</h2>
                    
                    {viewMode === 'grid' ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                        {filteredFolders.map(folder => (
                          <div 
                            key={folder.id} 
                            onClick={() => setCurrentFolderId(folder.id)}
                            draggable={true}
                            onDragStart={(e) => handleDragStart(e, folder, 'folder')}
                            onDragOver={(e) => handleDragOver(e, folder.id)}
                            onDragLeave={handleDragLeave}
                            onDrop={(e) => handleDrop(e, folder.id)}
                            className={`p-4 bg-white border rounded-xl shadow-sm cursor-pointer transition-all group relative flex items-center justify-between ${
                              dragOverFolderId === folder.id 
                                ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200' 
                                : 'border-gray-200 hover:shadow-md hover:border-blue-300'
                            }`}
                          >
                            <div className="flex items-center truncate pr-2">
                              <Folder className="w-8 h-8 text-blue-500 mr-3 flex-shrink-0" fill="currentColor" opacity={0.8} />
                              <span className="font-semibold text-gray-700 truncate">{folder.name}</span>
                            </div>
                            <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation(); e.preventDefault();
                                  setTimeout(() => setContextMenu({ isOpen: true, x: e.clientX, y: e.clientY, item: folder, type: 'folder' }), 0);
                                }}
                                className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-md"
                              >
                                <MoreVertical size={16} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider border-b border-gray-200">
                              <th className="p-4 font-semibold w-full">Tên</th>
                              <th className="p-4 font-semibold text-right whitespace-nowrap">Tuỳ chọn</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {filteredFolders.map(folder => (
                              <tr 
                                key={folder.id} 
                                onClick={() => setCurrentFolderId(folder.id)}
                                draggable={true}
                                onDragStart={(e) => handleDragStart(e, folder, 'folder')}
                                onDragOver={(e) => handleDragOver(e, folder.id)}
                                onDragLeave={handleDragLeave}
                                onDrop={(e) => handleDrop(e, folder.id)}
                                className={`cursor-pointer transition-colors group ${
                                  dragOverFolderId === folder.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                                }`}
                              >
                                <td className="p-4 flex items-center gap-3">
                                  <Folder className="w-6 h-6 text-blue-500 flex-shrink-0" fill="currentColor" opacity={0.8} />
                                  <span className="font-medium text-gray-800">{folder.name}</span>
                                </td>
                                <td className="p-4 text-right">
                                  <button 
                                    onClick={(e) => {
                                      e.stopPropagation(); e.preventDefault();
                                      setTimeout(() => setContextMenu({ isOpen: true, x: e.clientX, y: e.clientY, item: folder, type: 'folder' }), 0);
                                    }}
                                    className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-500 hover:bg-gray-200 rounded-md transition-opacity inline-flex items-center"
                                  >
                                    <MoreVertical size={16} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* Files Section */}
                {filteredFiles.length > 0 && (
                  <div>
                    <h2 className="text-sm font-bold text-gray-500 mb-4 uppercase tracking-wider">Tệp tin</h2>
                    
                    {viewMode === 'grid' ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                        {filteredFiles.map(file => (
                          <div 
                            key={file.id} 
                            draggable={true}
                            onDragStart={(e) => handleDragStart(e, file, 'file')}
                            onClick={() => file.status === 'complete' && router.push(`/preview/${file.id}`)}
                            className="p-4 bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-md hover:border-blue-300 transition-all group flex flex-col justify-between cursor-pointer"
                          >
                            <div className="flex items-start mb-4">
                              <div className="w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center mr-3 border border-gray-100 flex-shrink-0">
                                <FileText className="w-5 h-5 text-gray-500" />
                              </div>
                              <div className="overflow-hidden flex-1">
                                <span className="font-semibold text-gray-800 text-sm truncate block" title={file.filename}>
                                  {file.filename}
                                </span>
                                <span className="text-xs text-gray-500 mt-1">
                                  {file.status === 'uploading' ? (
                                    <span className="text-blue-500 font-medium flex items-center gap-1">
                                      <Loader2 size={12} className="animate-spin" /> Xử lí...
                                    </span>
                                  ) : formatSize(Number(file.size))}
                                </span>
                              </div>
                            </div>
                            <div className="flex gap-2 mt-auto">
                              {file.status === 'uploading' ? (
                                <button
                                  onClick={(e) => handleDeleteStuckFile(e, file.id)}
                                  className="w-full p-2 text-red-500 bg-red-50 rounded-lg hover:bg-red-100 transition-colors flex items-center justify-center gap-1 text-sm font-medium"
                                >
                                  <Trash2 size={14} /> Kẹt? Xoá ngay
                                </button>
                              ) : (
                                <>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation(); e.preventDefault();
                                      setTimeout(() => setContextMenu({ isOpen: true, x: e.clientX, y: e.clientY, item: file, type: 'file' }), 0);
                                    }}
                                    className="p-2 text-gray-500 bg-gray-50 border border-gray-100 rounded-lg hover:bg-gray-100 transition-colors"
                                  >
                                    <MoreVertical size={16} />
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!downloadingFiles.has(file.id)) handleDownload(file.id, file.filename);
                                    }}
                                    disabled={downloadingFiles.has(file.id)}
                                    className={`flex-1 flex items-center justify-center gap-1 border border-gray-100 bg-gray-50 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-100 text-gray-700 p-2 rounded-lg font-semibold text-sm transition-colors ${downloadingFiles.has(file.id) ? 'opacity-50 pointer-events-none' : ''}`}
                                  >
                                    {downloadingFiles.has(file.id) ? (
                                      <><Loader2 size={14} className="animate-spin" /> Đang tải...</>
                                    ) : (
                                      <><Download size={14} /> Tải về</>
                                    )}
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider border-b border-gray-200">
                              <th className="p-4 font-semibold">Tên tập tin</th>
                              <th className="p-4 font-semibold hidden sm:table-cell">Kích thước</th>
                              <th className="p-4 font-semibold text-right">Tuỳ chọn</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {filteredFiles.map(file => (
                              <tr 
                                key={file.id} 
                                draggable={true}
                                onDragStart={(e) => handleDragStart(e, file, 'file')}
                                onClick={() => file.status === 'complete' && router.push(`/preview/${file.id}`)}
                                className="hover:bg-gray-50 cursor-pointer transition-colors group"
                              >
                                <td className="p-4">
                                  <div className="flex items-center gap-3">
                                    <FileText className="w-5 h-5 text-gray-400 flex-shrink-0" />
                                    <div>
                                      <span className="font-medium text-gray-800 block truncate max-w-[150px] sm:max-w-xs md:max-w-sm">{file.filename}</span>
                                      {file.status === 'uploading' && (
                                        <span className="text-blue-500 text-xs font-medium flex items-center gap-1 mt-0.5">
                                          <Loader2 size={12} className="animate-spin" /> Đang xử lí...
                                        </span>
                                      )}
                                      {/* Show size on mobile under the name */}
                                      <span className="text-xs text-gray-500 sm:hidden block mt-0.5">{formatSize(Number(file.size))}</span>
                                    </div>
                                  </div>
                                </td>
                                <td className="p-4 text-sm text-gray-600 hidden sm:table-cell">
                                  {file.status === 'complete' ? formatSize(Number(file.size)) : '-'}
                                </td>
                                <td className="p-4 text-right whitespace-nowrap">
                                  {file.status === 'uploading' ? (
                                    <button
                                      onClick={(e) => handleDeleteStuckFile(e, file.id)}
                                      className="p-1.5 text-red-500 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                                    >
                                      <Trash2 size={16} />
                                    </button>
                                  ) : (
                                    <div className="flex justify-end gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (!downloadingFiles.has(file.id)) handleDownload(file.id, file.filename);
                                        }}
                                        disabled={downloadingFiles.has(file.id)}
                                        className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-md transition-colors disabled:opacity-50"
                                      >
                                        <Download size={16} />
                                      </button>
                                      <button 
                                        onClick={(e) => {
                                          e.stopPropagation(); e.preventDefault();
                                          setTimeout(() => setContextMenu({ isOpen: true, x: e.clientX, y: e.clientY - 20, item: file, type: 'file' }), 0);
                                        }}
                                        className="p-1.5 text-gray-500 hover:bg-gray-200 rounded-md transition-opacity"
                                      >
                                        <MoreVertical size={16} />
                                      </button>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Upload Zone */}
            <div className="mt-8 pt-6 border-t border-gray-100">
              <h3 className="text-xs font-bold text-gray-400 mb-4 uppercase tracking-wider">Tải lên dữ liệu mới</h3>
              <UploadZone folderId={currentFolderId} onUploadSuccess={() => { fetchContent(); fetchQuota(); }} />
            </div>

          </div>
        </div>
      </main>

      {/* Context Menu */}
      {contextMenu.isOpen && contextMenu.item && (
        <div 
          className="fixed bg-white border border-gray-200 rounded-xl shadow-[0_10px_40px_-10px_rgba(0,0,0,0.15)] w-48 py-2 z-50 text-sm"
          style={{ 
            top: Math.min(contextMenu.y, window.innerHeight - 200), 
            left: Math.min(contextMenu.x, window.innerWidth - 200) 
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            onClick={() => handleOpenDialog('rename')}
            className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-gray-700 cursor-pointer transition-colors"
          >
            <Edit2 size={16} /> Đổi tên
          </button>
          <button 
            onClick={() => handleOpenDialog('move')}
            className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-gray-700 cursor-pointer transition-colors"
          >
            <Move size={16} /> Di chuyển
          </button>
          <button 
            onClick={() => handleOpenDialog('share')}
            className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-blue-600 font-medium cursor-pointer transition-colors"
          >
            <Share2 size={16} /> Chia sẻ
          </button>
          <div className="border-t border-gray-100 my-1"></div>
          <button 
            onClick={(e) => {
              contextMenu.type === 'folder' 
                ? handleDeleteFolder(e, contextMenu.item.id) 
                : handleDeleteFile(e, contextMenu.item.id);
              setContextMenu(prev => ({ ...prev, isOpen: false }));
            }}
            className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-red-600 font-medium cursor-pointer transition-colors"
          >
            <Trash2 size={16} /> Xoá
          </button>
        </div>
      )}

      {/* Dialogs */}
      <RenameDialog
        isOpen={activeDialog === 'rename'}
        onClose={() => setActiveDialog('none')}
        initialName={dialogItem ? (dialogItem.name || dialogItem.filename) : ''}
        itemType={dialogItemType}
        onConfirm={async (newName) => {
          try {
            const endpoint = dialogItemType === 'folder' ? 'folders' : 'files';
            await axios.patch(`${API_URL}/${endpoint}/${dialogItem.id}/rename`, { name: newName }, {
              headers: { Authorization: `Bearer ${token}` }
            });
            setActiveDialog('none');
            fetchContent();
          } catch (error) {
            alert('Lỗi đổi tên');
          }
        }}
      />

      <MoveDialog
        isOpen={activeDialog === 'move'}
        onClose={() => setActiveDialog('none')}
        itemToMove={dialogItem}
        itemType={dialogItemType}
        token={token}
        onConfirm={async (destFolderId) => {
          try {
            const endpoint = dialogItemType === 'folder' ? 'folders' : 'files';
            await axios.patch(`${API_URL}/${endpoint}/${dialogItem.id}/move`, { 
              folderId: destFolderId, // cho file
              parentId: destFolderId  // cho folder
            }, {
              headers: { Authorization: `Bearer ${token}` }
            });
            setActiveDialog('none');
            fetchContent();
          } catch (error: any) {
            alert(error.response?.data?.message || 'Lỗi di chuyển');
          }
        }}
      />

      <ShareDialog
        isOpen={activeDialog === 'share'}
        onClose={() => setActiveDialog('none')}
        item={dialogItem}
        itemType={dialogItemType}
        token={token}
      />

    </div>
  );
}
