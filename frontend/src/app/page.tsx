'use client';

import { useState, useEffect, useCallback } from 'react';
import { Folder, FileText, Download, Trash2, FolderPlus, MoreVertical, Loader2, Search, LayoutGrid, List } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-context';
import { useI18n } from '@/components/i18n-context';
import Sidebar from '@/components/sidebar';
import Breadcrumbs from '@/components/breadcrumbs';
import ContextMenu from '@/components/context-menu';
import UploadZone from '@/components/upload-zone';
import RenameDialog from '@/components/rename-dialog';
import ShareDialog from '@/components/share-dialog';
import MoveDialog from '@/components/move-dialog';
import toast from 'react-hot-toast';
import {
  formatSize, fetchFolderContent, fetchBreadcrumbs,
  createFolder, deleteFolder, restoreFolder, deleteFile, restoreFile,
  abortUpload, getDownloadUrl, renameItem, moveItem,
} from '@/lib/api';

export default function Dashboard() {
  const { user, token, isLoading, logout } = useAuth();
  const router = useRouter();
  const { t } = useI18n();

  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>(undefined);
  const [folders, setFolders] = useState<any[]>([]);
  const [files, setFiles] = useState<any[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<any[]>([]);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(new Set());

  // UI Polish States
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('viewMode') as 'grid' | 'list') || 'grid';
    }
    return 'grid';
  });
  const [searchQuery, setSearchQuery] = useState('');
  // Persist viewMode to localStorage
  useEffect(() => {
    localStorage.setItem('viewMode', viewMode);
  }, [viewMode]);

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

  const fetchContent = useCallback(async () => {
    if (!token) return;
    try {
      const data = await fetchFolderContent(currentFolderId);
      setFolders(data.folders);
      setFiles(data.files);

      if (currentFolderId) {
        const bc = await fetchBreadcrumbs(currentFolderId);
        setBreadcrumbs(bc);
      } else {
        setBreadcrumbs([]);
      }
    } catch (error: any) {
      if (error?.response?.status === 401) {
        logout();
        router.push('/login');
        return;
      }
    }
  }, [currentFolderId, token, logout, router]);

  useEffect(() => {
    fetchContent();
  }, [fetchContent]);

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
      await createFolder(newFolderName, currentFolderId);
      setNewFolderName('');
      setShowNewFolder(false);
      fetchContent();
    } catch (error: any) {
      alert(error?.response?.data?.message || t('dashboard.createFolderError'));
    } finally {
      setIsCreatingFolder(false);
    }
  };

  const handleDeleteFolder = async (e: any, id: string) => {
    e.stopPropagation();
    try {
      await deleteFolder(id);
      fetchContent();
      toast.success(
        (toastInstance) => (
          <span className="flex items-center gap-2">
            {t('dashboard.deletedFolder')}
            <button
              onClick={async () => {
                toast.dismiss(toastInstance.id);
                try {
                  await restoreFolder(id);
                  fetchContent();
                } catch(err) {
                  alert(t('dashboard.undoError'));
                }
              }}
              className="text-blue-500 font-semibold text-sm hover:underline ml-2 cursor-pointer"
            >
              {t('dashboard.undo')}
            </button>
          </span>
        ),
        { duration: 5000 }
      );
    } catch (error: any) {
      alert(error?.response?.data?.message || t('dashboard.deleteStuckError'));
    }
  };

  const handleDeleteFile = async (e: any, id: string) => {
    e.stopPropagation();
    try {
      await deleteFile(id);
      fetchContent();
      toast.success(
        (toastInstance) => (
          <span className="flex items-center gap-2">
            {t('dashboard.deletedFile')}
            <button
              onClick={async () => {
                toast.dismiss(toastInstance.id);
                try {
                  await restoreFile(id);
                  fetchContent();
                } catch(err) {
                  alert(t('dashboard.undoError'));
                }
              }}
              className="text-blue-500 font-semibold text-sm hover:underline ml-2 cursor-pointer"
            >
              {t('dashboard.undo')}
            </button>
          </span>
        ),
        { duration: 5000 }
      );
    } catch (error: any) {
      alert(error?.response?.data?.message || t('dashboard.deleteStuckError'));
    }
  };

  const handleDeleteStuckFile = async (e: any, id: string) => {
    e.stopPropagation();
    try {
      await abortUpload(id);
      fetchContent();
    } catch (error: any) {
      alert(error?.response?.data?.message || t('dashboard.deleteStuckError'));
    }
  };

  /**
   * Download file — dùng link trực tiếp với token query param để trình duyệt
   * hiện hộp thoại download ngay, không cần buffer toàn bộ file vào RAM.
   */
  const handleDownload = async (fileId: string, filename: string) => {
    setDownloadingFiles((prev) => new Set(prev).add(fileId));
    try {
      const downloadUrl = getDownloadUrl(fileId, token!);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      setTimeout(() => {
        setDownloadingFiles((prev) => {
          const next = new Set(prev);
          next.delete(fileId);
          return next;
        });
      }, 2000);
    }
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
      await moveItem(draggedItem.type, draggedItem.id, targetFolderId);
      fetchContent();
    } catch (error: any) {
      alert(error.response?.data?.message || t('dashboard.moveError'));
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
        <div className="text-gray-500">{t('dashboard.loading')}</div>
      </div>
    );
  }

  // Chưa login (redirect sẽ xảy ra bởi useEffect)
  if (!token) return null;

  return (
    <div className="h-screen bg-white flex overflow-hidden">

      <Sidebar />

      {/* Main Area */}
      <main className="flex-1 flex flex-col min-w-0 bg-white relative">

        {/* Topbar */}
        <header className="h-16 border-b border-gray-100 flex items-center justify-between px-4 lg:px-6 bg-white w-full flex-shrink-0 z-10 transition-shadow">
          <div className="flex items-center gap-4 flex-1">
            <div className="relative max-w-xl w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
              <input
                type="text"
                placeholder={t('dashboard.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-50 rounded-xl outline-none transition-all text-sm font-medium"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 ml-4">
            <button
              onClick={() => setShowNewFolder(!showNewFolder)}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg font-medium transition-colors text-white text-sm shadow-sm"
            >
              <FolderPlus size={16} /> <span className="hidden sm:inline">{t('dashboard.newFolder')}</span>
            </button>
            <div className="hidden sm:flex bg-gray-50 p-1 rounded-lg border border-gray-200">
              <button 
                onClick={() => setViewMode('grid')}
                className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
                title={t('dashboard.gridView')}
              >
                <LayoutGrid size={18} />
              </button>
              <button 
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
                title={t('dashboard.listView')}
              >
                <List size={18} />
              </button>
            </div>
          </div>
        </header>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto">
          
          {/* Breadcrumbs */}
          <Breadcrumbs
            items={breadcrumbs}
            onNavigate={setCurrentFolderId}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            dragOverFolderId={dragOverFolderId}
          />

          <div className="p-6">
            
            {/* Create Folder Box */}
            {showNewFolder && (
              <div className="flex gap-2 p-4 mb-6 bg-blue-50/50 border border-blue-100 rounded-xl shadow-sm">
                <input 
                  type="text" 
                  placeholder={t('dashboard.folderNamePlaceholder')} 
                  className="border border-blue-200 p-2.5 rounded-lg flex-grow outline-none focus:ring-2 focus:ring-blue-500"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
                  autoFocus
                />
                <button onClick={handleCreateFolder} disabled={isCreatingFolder} className="bg-blue-600 text-white px-6 rounded-lg hover:bg-blue-700 font-medium transition-colors shadow-sm disabled:opacity-50">
                  {isCreatingFolder ? t('dashboard.creating') : t('dashboard.create')}
                </button>
                <button onClick={() => setShowNewFolder(false)} className="bg-white border border-gray-200 text-gray-700 px-6 rounded-lg hover:bg-gray-50 font-medium transition-colors">{t('common.cancel')}</button>
              </div>
            )}

            {filteredFolders.length === 0 && filteredFiles.length === 0 ? (
              <div className="text-center py-20 bg-gray-50/50 rounded-2xl border-2 border-dashed border-gray-200 mt-4">
                <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mx-auto mb-4 shadow-sm border border-gray-100">
                  <Folder className="text-gray-300" size={32} />
                </div>
                {searchQuery ? (
                  <p className="text-gray-500 font-medium">{t('dashboard.noResults')}</p>
                ) : (
                  <p className="text-gray-500 font-medium">{t('dashboard.emptyFolder')}</p>
                )}
              </div>
            ) : (
              <>
                {/* Folders Section */}
                {filteredFolders.length > 0 && (
                  <div className="mb-8">
                    <h2 className="text-sm font-bold text-gray-500 mb-4 uppercase tracking-wider">{t('dashboard.folders')}</h2>
                    
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
                              <th className="p-4 font-semibold w-full">{t('dashboard.name')}</th>
                              <th className="p-4 font-semibold text-right whitespace-nowrap">{t('dashboard.options')}</th>
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
                    <h2 className="text-sm font-bold text-gray-500 mb-4 uppercase tracking-wider">{t('dashboard.files')}</h2>
                    
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
                                      <Loader2 size={12} className="animate-spin" /> {t('dashboard.processing')}
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
                                  <Trash2 size={14} /> {t('dashboard.stuckDelete')}
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
                                      <><Loader2 size={14} className="animate-spin" /> {t('dashboard.downloading')}</>
                                    ) : (
                                      <><Download size={14} /> {t('dashboard.download')}</>
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
                              <th className="p-4 font-semibold">{t('dashboard.fileName')}</th>
                              <th className="p-4 font-semibold hidden sm:table-cell">{t('dashboard.size')}</th>
                              <th className="p-4 font-semibold text-right">{t('dashboard.options')}</th>
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
                                          <Loader2 size={12} className="animate-spin" /> {t('dashboard.listProcessing')}
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
              <h3 className="text-xs font-bold text-gray-400 mb-4 uppercase tracking-wider">{t('dashboard.uploadTitle')}</h3>
              <UploadZone folderId={currentFolderId} onUploadSuccess={() => { fetchContent(); }} />
            </div>

          </div>
        </div>
      </main>

      {/* Context Menu */}
      {contextMenu.isOpen && contextMenu.item && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          itemType={contextMenu.type}
          onRename={() => handleOpenDialog('rename')}
          onMove={() => handleOpenDialog('move')}
          onShare={() => handleOpenDialog('share')}
          onDelete={(e) => {
            contextMenu.type === 'folder'
              ? handleDeleteFolder(e, contextMenu.item.id)
              : handleDeleteFile(e, contextMenu.item.id);
            setContextMenu(prev => ({ ...prev, isOpen: false }));
          }}
        />
      )}

      {/* Dialogs */}
      <RenameDialog
        isOpen={activeDialog === 'rename'}
        onClose={() => setActiveDialog('none')}
        initialName={dialogItem ? (dialogItem.name || dialogItem.filename) : ''}
        itemType={dialogItemType}
        onConfirm={async (newName) => {
          try {
            await renameItem(dialogItemType, dialogItem.id, newName);
            setActiveDialog('none');
            fetchContent();
          } catch (error) {
            alert(t('dashboard.renameError'));
          }
        }}
      />

      <MoveDialog
        isOpen={activeDialog === 'move'}
        onClose={() => setActiveDialog('none')}
        itemToMove={dialogItem}
        itemType={dialogItemType}
        onConfirm={async (destFolderId) => {
          try {
            await moveItem(dialogItemType, dialogItem.id, destFolderId);
            setActiveDialog('none');
            fetchContent();
          } catch (error: any) {
            alert(error.response?.data?.message || t('dashboard.moveError'));
          }
        }}
      />

      <ShareDialog
        isOpen={activeDialog === 'share'}
        onClose={() => setActiveDialog('none')}
        item={dialogItem}
        itemType={dialogItemType}
      />

    </div>
  );
}
