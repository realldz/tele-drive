'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Folder, Download, Trash2, MoreVertical, Loader2, Search, LayoutGrid, List, File, FolderOpen, Globe, Plus, FolderPlus, ChevronUp, ChevronDown } from 'lucide-react';
import { useI18n, LOCALE_DATE_MAP } from '@/components/i18n-context';
import { useRequireAuth } from '@/hooks/use-require-auth';
import { useLazyLoad } from '@/hooks/use-lazy-load';
import { useSelection } from '@/hooks/use-selection';
import { useDragSelect, DragSelectOverlay } from '@/hooks/use-drag-select';
import { getFileIcon } from '@/lib/file-icon';
import Sidebar from '@/components/sidebar';
import Breadcrumbs from '@/components/breadcrumbs';
import ContextMenu from '@/components/context-menu';
import SelectionActionBar from '@/components/selection-action-bar';
import FilePreviewModal from '@/components/file-preview-modal';
import CreateFolderDialog from '@/components/create-folder-dialog';
import FileDetailsDialog from '@/components/file-details-dialog';
import { useUpload } from '@/components/upload-context';
import RenameDialog from '@/components/rename-dialog';
import ShareDialog from '@/components/share-dialog';
import MoveDialog from '@/components/move-dialog';
import toast from 'react-hot-toast';
import axios from 'axios';
import {
  formatSize, fetchFolderContent, fetchBreadcrumbs,
  createFolder, deleteFolder, restoreFolder, deleteFile, restoreFile,
  abortUpload, requestDownloadToken, renameItem, moveItem, getApiErrorMessage, formatBandwidthResetTime, API_URL,
} from '@/lib/api';
import type { FileRecord, FolderRecord, BreadcrumbItem } from '@/lib/types';

type SortField = 'name' | 'createdAt';
type SortDirection = 'asc' | 'desc';

export default function Dashboard() {
  const { isReady, token } = useRequireAuth();
  const { t, locale } = useI18n();
  const { setCurrentFolderId: setUploadFolderId, setOnUploadSuccess, addFiles, addFolder } = useUpload();

  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>(undefined);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(new Set());
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  // Modal / dialog state
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [activeDialog, setActiveDialog] = useState<'rename' | 'move' | 'share' | 'details' | 'batchMove' | 'none'>('none');
  const [dialogItem, setDialogItem] = useState<FileRecord | FolderRecord | null>(null);
  const [dialogItemType, setDialogItemType] = useState<'file' | 'folder'>('file');

  // "New" dropdown
  const [showNewMenu, setShowNewMenu] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // View mode
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('viewMode') as 'grid' | 'list') || 'grid';
    }
    return 'grid';
  });
  useEffect(() => { localStorage.setItem('viewMode', viewMode); }, [viewMode]);

  // Search + mobile toggle
  const [searchQuery, setSearchQuery] = useState('');
  const [showMobileSearch, setShowMobileSearch] = useState(false);

  // Sorting (list view)
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Selection
  const selection = useSelection();
  const contentRef = useRef<HTMLDivElement>(null);

  const handleDragSelect = useCallback((ids: string[]) => {
    selection.selectAll(ids);
  }, [selection]);

  const { isDragging, rect: dragRect } = useDragSelect({
    containerRef: contentRef,
    onSelect: handleDragSelect,
  });

  const handleSort = useCallback((field: SortField) => {
    setSortDirection(prev => sortField === field ? (prev === 'asc' ? 'desc' : 'asc') : 'desc');
    setSortField(field);
  }, [sortField]);

  // Filter + sort
  const filteredFolders = useMemo(() => {
    const filtered = folders.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()));
    return [...filtered].sort((a, b) => {
      const cmp = sortField === 'name'
        ? a.name.localeCompare(b.name)
        : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [folders, searchQuery, sortField, sortDirection]);

  const filteredFiles = useMemo(() => {
    const filtered = files.filter(f => f.filename.toLowerCase().includes(searchQuery.toLowerCase()));
    return [...filtered].sort((a, b) => {
      const cmp = sortField === 'name'
        ? a.filename.localeCompare(b.filename)
        : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [files, searchQuery, sortField, sortDirection]);

  // Ordered IDs for shift-select
  const orderedIds = useMemo(
    () => [...filteredFolders.map(f => f.id), ...filteredFiles.map(f => f.id)],
    [filteredFolders, filteredFiles],
  );

  // Lazy load
  const totalItems = filteredFolders.length + filteredFiles.length;
  const { visibleCount, hasMore, loadMoreRef, resetCount } = useLazyLoad(totalItems);
  useEffect(() => resetCount(), [currentFolderId, searchQuery, resetCount]);

  const visibleFolders = filteredFolders.slice(0, visibleCount);
  const visibleFiles = filteredFiles.slice(0, Math.max(0, visibleCount - filteredFolders.length));

  // Context menu
  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean; x: number; y: number;
    item: FileRecord | FolderRecord | null; type: 'file' | 'folder';
  }>({ isOpen: false, x: 0, y: 0, item: null, type: 'file' });

  // Drag and Drop
  const [draggedItem, setDraggedItem] = useState<{ id: string; type: 'file' | 'folder' } | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);

  // Close context menu on click anywhere
  useEffect(() => {
    const handler = () => setContextMenu(prev => ({ ...prev, isOpen: false }));
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  // Close "New" dropdown on click outside
  useEffect(() => {
    if (!showNewMenu) return;
    const handler = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) setShowNewMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showNewMenu]);

  // Clear selection when folder changes
  useEffect(() => { selection.clearSelection(); }, [currentFolderId, selection.clearSelection]);

  // Fetch content
  const fetchContent = useCallback(async () => {
    if (!token) return;
    setIsLoadingContent(true);
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
    } catch {
      // 401 handled by axios interceptor
    } finally {
      setIsLoadingContent(false);
    }
  }, [currentFolderId, token]);

  useEffect(() => { fetchContent(); }, [fetchContent]);
  useEffect(() => { setUploadFolderId(currentFolderId); }, [currentFolderId, setUploadFolderId]);
  useEffect(() => {
    setOnUploadSuccess(fetchContent);
    return () => setOnUploadSuccess(undefined);
  }, [fetchContent, setOnUploadSuccess]);

  // Polling for uploading files
  useEffect(() => {
    const hasUploading = files.some(f => f.status === 'uploading');
    if (hasUploading && !searchQuery) {
      const id = setInterval(fetchContent, 3000);
      return () => clearInterval(id);
    }
  }, [files, fetchContent, searchQuery]);

  // Handlers
  const handleCreateFolder = useCallback(async (name: string) => {
    try {
      await createFolder(name, currentFolderId);
      setShowCreateFolder(false);
      fetchContent();
    } catch (error: unknown) {
      alert(getApiErrorMessage(error, t('dashboard.createFolderError')));
    }
  }, [currentFolderId, fetchContent, t]);

  const handleDeleteFolder = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await deleteFolder(id);
      fetchContent();
      toast.success((ti) => (
        <span className="flex items-center gap-2">
          {t('dashboard.deletedFolder')}
          <button onClick={async () => { toast.dismiss(ti.id); try { await restoreFolder(id); fetchContent(); } catch { alert(t('dashboard.undoError')); } }}
            className="text-blue-500 font-semibold text-sm hover:underline ml-2 cursor-pointer">{t('dashboard.undo')}</button>
        </span>
      ), { duration: 5000 });
    } catch (error: unknown) { alert(getApiErrorMessage(error, t('dashboard.deleteStuckError'))); }
  }, [fetchContent, t]);

  const handleDeleteFile = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await deleteFile(id);
      fetchContent();
      toast.success((ti) => (
        <span className="flex items-center gap-2">
          {t('dashboard.deletedFile')}
          <button onClick={async () => { toast.dismiss(ti.id); try { await restoreFile(id); fetchContent(); } catch { alert(t('dashboard.undoError')); } }}
            className="text-blue-500 font-semibold text-sm hover:underline ml-2 cursor-pointer">{t('dashboard.undo')}</button>
        </span>
      ), { duration: 5000 });
    } catch (error: unknown) { alert(getApiErrorMessage(error, t('dashboard.deleteStuckError'))); }
  }, [fetchContent, t]);

  const handleDeleteStuckFile = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try { await abortUpload(id); fetchContent(); }
    catch (error: unknown) { alert(getApiErrorMessage(error, t('dashboard.deleteStuckError'))); }
  }, [fetchContent, t]);

  const handleDownload = useCallback(async (fileId: string, filename: string) => {
    setDownloadingFiles(prev => new Set(prev).add(fileId));
    toast.loading(t('dashboard.downloadStarted'), { icon: '⬇️', duration: 2000 });
    try {
      const { url } = await requestDownloadToken(fileId);
      const link = document.createElement('a');
      link.href = API_URL + url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        const resetTime = formatBandwidthResetTime(err.response.headers?.['x-bandwidth-reset'], LOCALE_DATE_MAP[locale]);
        toast.error(resetTime
          ? t('dashboard.bandwidthExceededAt', { time: resetTime })
          : t('dashboard.bandwidthExceeded'));
      } else {
        toast.error(t('dashboard.downloadError'));
      }
    } finally {
      setTimeout(() => setDownloadingFiles(prev => { const n = new Set(prev); n.delete(fileId); return n; }), 2000);
    }
  }, [locale, t]);

  // Batch delete selected items
  const handleBatchDelete = useCallback(async () => {
    const ids = Array.from(selection.selectedIds);
    for (const id of ids) {
      const isFolder = folders.some(f => f.id === id);
      try {
        if (isFolder) {
          await deleteFolder(id);
        } else {
          await deleteFile(id);
        }
      } catch (error: unknown) {
        alert(getApiErrorMessage(error, t('dashboard.deleteStuckError')));
      }
    }
    selection.clearSelection();
    fetchContent();
    toast.success(t('dashboard.deletedFile'));
  }, [selection, folders, fetchContent, t]);

  // Batch move: open the move dialog
  const handleBatchMoveOpen = useCallback(() => {
    setActiveDialog('batchMove');
  }, []);

  const handleBatchMoveConfirm = useCallback(async (destFolderId: string | null) => {
    const ids = Array.from(selection.selectedIds);
    for (const id of ids) {
      const isFolder = folders.some(f => f.id === id);
      try {
        await moveItem(isFolder ? 'folder' : 'file', id, destFolderId);
      } catch (error: unknown) {
        alert(getApiErrorMessage(error, t('dashboard.moveError')));
      }
    }
    selection.clearSelection();
    setActiveDialog('none');
    fetchContent();
  }, [selection, folders, fetchContent, t]);

  const handleDragStart = (e: React.DragEvent, item: FileRecord | FolderRecord, type: 'file' | 'folder') => {
    setDraggedItem({ id: item.id, type }); e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (e: React.DragEvent, folderId: string | null) => {
    e.preventDefault(); e.stopPropagation();
    if (draggedItem && draggedItem.id !== folderId) setDragOverFolderId(folderId);
  };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOverFolderId(null); };
  const handleDrop = async (e: React.DragEvent, targetFolderId: string | null) => {
    e.preventDefault(); e.stopPropagation(); setDragOverFolderId(null);
    if (!draggedItem || targetFolderId === (currentFolderId || null) || draggedItem.id === targetFolderId) return;
    try { await moveItem(draggedItem.type, draggedItem.id, targetFolderId); fetchContent(); }
    catch (error: unknown) { alert(getApiErrorMessage(error, t('dashboard.moveError'))); }
    setDraggedItem(null);
  };

  const openContextMenu = useCallback((e: React.MouseEvent, item: FileRecord | FolderRecord, type: 'file' | 'folder') => {
    e.preventDefault(); e.stopPropagation();
    // If item is not in selection, select it alone
    if (!selection.isSelected(item.id)) {
      selection.clearSelection();
      selection.handleSelect(item.id, { ...e, ctrlKey: false, metaKey: false, shiftKey: false, stopPropagation: () => {} } as React.MouseEvent, orderedIds);
    }
    setTimeout(() => setContextMenu({ isOpen: true, x: e.clientX, y: e.clientY, item, type }), 0);
  }, [selection, orderedIds]);

  const handleOpenDialog = useCallback((targetDialog: 'rename' | 'move' | 'share' | 'details') => {
    setActiveDialog(targetDialog);
    setDialogItem(contextMenu.item);
    setDialogItemType(contextMenu.type);
    setContextMenu(prev => ({ ...prev, isOpen: false }));
  }, [contextMenu.item, contextMenu.type]);

  // Handle click on an item (selection)
  const handleItemClick = useCallback((e: React.MouseEvent, item: FileRecord | FolderRecord, type: 'file' | 'folder') => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      // Multi-select mode
      selection.handleSelect(item.id, e, orderedIds);
    } else {
      // Single click behavior
      if (type === 'folder') {
        setCurrentFolderId(item.id);
      } else {
        const file = item as FileRecord;
        if (file.status === 'complete') setPreviewFileId(file.id);
      }
    }
  }, [selection, orderedIds]);

  const formatDate = useCallback((d: string) => new Date(d).toLocaleDateString(LOCALE_DATE_MAP[locale]), [locale]);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDirection === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />;
  };

  // Handle context menu actions for batch
  const handleContextMenuDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setContextMenu(prev => ({ ...prev, isOpen: false }));
    if (selection.selectedCount > 1) {
      handleBatchDelete();
    } else if (contextMenu.item) {
      if (contextMenu.type === 'folder') {
        handleDeleteFolder(e, contextMenu.item.id);
      } else {
        handleDeleteFile(e, contextMenu.item.id);
      }
    }
  }, [selection.selectedCount, contextMenu, handleBatchDelete, handleDeleteFolder, handleDeleteFile]);

  const handleContextMenuMove = useCallback(() => {
    setContextMenu(prev => ({ ...prev, isOpen: false }));
    if (selection.selectedCount > 1) {
      handleBatchMoveOpen();
    } else {
      handleOpenDialog('move');
    }
  }, [selection.selectedCount, handleBatchMoveOpen, handleOpenDialog]);

  if (!isReady) {
    return (<div className="min-h-screen bg-gray-50 flex items-center justify-center"><Loader2 className="animate-spin text-blue-500" size={32} /></div>);
  }

  return (
    <div className="h-screen bg-white flex overflow-hidden">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 bg-white relative"
        onClick={(e) => {
          // Click on empty area -> clear selection
          if (e.target === e.currentTarget || (e.target as HTMLElement).closest('[data-content-area]')) {
            if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
              selection.clearSelection();
            }
          }
        }}
      >

        {/* Topbar */}
        <header className="h-16 border-b border-gray-100 flex items-center justify-between pl-14 pr-4 md:px-4 lg:px-6 bg-white w-full flex-shrink-0 z-10">
          {/* Search — always visible on md+, toggleable on mobile */}
          <div className={`flex items-center gap-4 flex-1 ${showMobileSearch ? '' : 'hidden md:flex'}`}>
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

          <div className="flex items-center gap-2 ml-auto">
            {/* Mobile search toggle */}
            <button onClick={() => setShowMobileSearch(!showMobileSearch)} className="md:hidden p-2 text-gray-500 hover:bg-gray-100 rounded-lg">
              <Search size={20} />
            </button>

            {/* "New" button (Google Drive style) */}
            <div className="relative" ref={newMenuRef}>
              <button
                onClick={() => setShowNewMenu(!showNewMenu)}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg font-medium transition-colors text-white text-sm shadow-sm"
              >
                <Plus size={16} /> <span className="hidden sm:inline">{t('dashboard.new')}</span>
              </button>
              {showNewMenu && (
                <div className="absolute right-0 mt-2 w-52 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1">
                  <button
                    onClick={() => { setShowNewMenu(false); setShowCreateFolder(true); }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <FolderPlus size={16} className="text-blue-500" /> {t('dashboard.newFolder')}
                  </button>
                  <div className="border-t border-gray-100 my-1" />
                  <button
                    onClick={() => { fileInputRef.current?.click(); setShowNewMenu(false); }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <File size={16} className="text-gray-400" /> {t('upload.uploadFile')}
                  </button>
                  <button
                    onClick={() => { folderInputRef.current?.click(); setShowNewMenu(false); }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <FolderOpen size={16} className="text-gray-400" /> {t('upload.uploadFolder')}
                  </button>
                </div>
              )}
            </div>

            <input ref={fileInputRef} type="file" multiple onChange={(e) => { if (e.target.files?.length) { addFiles(e.target.files, currentFolderId); e.target.value = ''; } }} hidden />
            <input ref={folderInputRef} type="file" {...{ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>} onChange={(e) => { if (e.target.files?.length) { addFolder(e.target.files, currentFolderId); e.target.value = ''; } }} hidden />

            {/* Grid/List toggle — always visible */}
            <div className="flex bg-gray-50 p-1 rounded-lg border border-gray-200">
              <button onClick={() => setViewMode('grid')} className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-400 hover:text-gray-600'}`} title={t('dashboard.gridView')}>
                <LayoutGrid size={18} />
              </button>
              <button onClick={() => setViewMode('list')} className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-400 hover:text-gray-600'}`} title={t('dashboard.listView')}>
                <List size={18} />
              </button>
            </div>
          </div>
        </header>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto relative" ref={contentRef} style={{ userSelect: isDragging ? 'none' : undefined }}>
          <DragSelectOverlay rect={dragRect} />
          <Breadcrumbs items={breadcrumbs} onNavigate={setCurrentFolderId} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} dragOverFolderId={dragOverFolderId} />

          <div className="px-2 py-6 md:px-6" data-content-area onClick={(e) => {
            // Only clear if clicking directly on content area background
            if (e.target === e.currentTarget && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
              selection.clearSelection();
            }
          }}>
            {/* Loading state */}
            {isLoadingContent && folders.length === 0 && files.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="animate-spin text-blue-500" size={32} />
              </div>
            ) : filteredFolders.length === 0 && filteredFiles.length === 0 ? (
              <div className="text-center py-20 bg-gray-50/50 rounded-2xl border-2 border-dashed border-gray-200 mt-4">
                <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mx-auto mb-4 shadow-sm border border-gray-100">
                  <Folder className="text-gray-300" size={32} />
                </div>
                <p className="text-gray-500 font-medium">{searchQuery ? t('dashboard.noResults') : t('dashboard.emptyFolder')}</p>
              </div>
            ) : (
              <>
                {/* Folders */}
                {filteredFolders.length > 0 && (
                  <div className="mb-8">
                    <h2 className="text-sm font-bold text-gray-500 mb-4 uppercase tracking-wider">{t('dashboard.folders')}</h2>
                    {viewMode === 'grid' ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                        {visibleFolders.map(folder => (
                          <div key={folder.id} data-selectable-id={folder.id}
                            onClick={(e) => handleItemClick(e, folder, 'folder')}
                            draggable
                            onDragStart={(e) => handleDragStart(e, folder, 'folder')} onDragOver={(e) => handleDragOver(e, folder.id)}
                            onDragLeave={handleDragLeave} onDrop={(e) => handleDrop(e, folder.id)}
                            onContextMenu={(e) => openContextMenu(e, folder, 'folder')}
                            className={`p-4 bg-white border rounded-xl shadow-sm cursor-pointer transition-all group relative flex items-center justify-between ${
                              selection.isSelected(folder.id)
                                ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                                : dragOverFolderId === folder.id
                                  ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                                  : 'border-gray-200 hover:shadow-md hover:border-blue-300'
                            }`}
                          >
                            <div className="flex items-center truncate pr-2">
                              <div className="relative mr-3 flex-shrink-0">
                                <Folder className="w-8 h-8 text-blue-500" fill="currentColor" opacity={0.8} />
                                {folder.visibility !== 'PRIVATE' && <Globe className="absolute -bottom-1 -right-1 w-3.5 h-3.5 text-green-600 bg-white rounded-full p-px" />}
                              </div>
                              <span className="font-semibold text-gray-700 truncate">{folder.name}</span>
                            </div>
                            <div className="flex items-center md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                              <button onClick={(e) => { e.stopPropagation(); openContextMenu(e, folder, 'folder'); }} className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-md">
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
                              <th className="p-3 md:p-4 font-semibold cursor-pointer select-none" onClick={() => handleSort('name')}>
                                <span className="flex items-center gap-1">{t('dashboard.name')} <SortIcon field="name" /></span>
                              </th>
                              <th className="p-3 md:p-4 font-semibold hidden sm:table-cell cursor-pointer select-none" onClick={() => handleSort('createdAt')}>
                                <span className="flex items-center gap-1">{t('dashboard.createdDate')} <SortIcon field="createdAt" /></span>
                              </th>
                              <th className="p-3 md:p-4 font-semibold text-right whitespace-nowrap">{t('dashboard.options')}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {visibleFolders.map(folder => (
                              <tr key={folder.id} data-selectable-id={folder.id}
                                onClick={(e) => handleItemClick(e, folder, 'folder')}
                                draggable
                                onDragStart={(e) => handleDragStart(e, folder, 'folder')} onDragOver={(e) => handleDragOver(e, folder.id)}
                                onDragLeave={handleDragLeave} onDrop={(e) => handleDrop(e, folder.id)}
                                onContextMenu={(e) => openContextMenu(e, folder, 'folder')}
                                className={`cursor-pointer transition-colors group ${
                                  selection.isSelected(folder.id)
                                    ? 'bg-blue-50'
                                    : dragOverFolderId === folder.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                                }`}
                              >
                                <td className="p-3 md:p-4 flex items-center gap-3">
                                  <div className="relative flex-shrink-0">
                                    <Folder className="w-6 h-6 text-blue-500" fill="currentColor" opacity={0.8} />
                                    {folder.visibility !== 'PRIVATE' && <Globe className="absolute -bottom-1 -right-1 w-3 h-3 text-green-600 bg-white rounded-full p-px" />}
                                  </div>
                                  <span className="font-medium text-gray-800">{folder.name}</span>
                                </td>
                                <td className="p-3 md:p-4 text-sm text-gray-500 hidden sm:table-cell">{formatDate(folder.createdAt)}</td>
                                <td className="p-3 md:p-4 text-right">
                                  <button onClick={(e) => { e.stopPropagation(); openContextMenu(e, folder, 'folder'); }}
                                    className="md:opacity-0 md:group-hover:opacity-100 p-1.5 text-gray-500 hover:bg-gray-200 rounded-md transition-opacity inline-flex items-center">
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

                {/* Files */}
                {filteredFiles.length > 0 && (
                  <div>
                    <h2 className="text-sm font-bold text-gray-500 mb-4 uppercase tracking-wider">{t('dashboard.files')}</h2>
                    {viewMode === 'grid' ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                        {visibleFiles.map(file => (
                          <div key={file.id} data-selectable-id={file.id} draggable onDragStart={(e) => handleDragStart(e, file, 'file')}
                            onClick={(e) => handleItemClick(e, file, 'file')}
                            onContextMenu={(e) => file.status === 'complete' && openContextMenu(e, file, 'file')}
                            className={`p-4 bg-white border rounded-xl shadow-sm transition-all group flex flex-col justify-between cursor-pointer ${
                              selection.isSelected(file.id)
                                ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                                : 'border-gray-200 hover:shadow-md hover:border-blue-300'
                            }`}
                          >
                            <div className="flex items-start mb-4">
                              <div className="relative w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center mr-3 border border-gray-100 flex-shrink-0">
                                {getFileIcon(file.mimeType, 'w-5 h-5')}
                                {file.visibility !== 'PRIVATE' && <Globe className="absolute -bottom-1 -right-1 w-3.5 h-3.5 text-green-600 bg-white rounded-full p-px" />}
                              </div>
                              <div className="overflow-hidden flex-1">
                                <span className="font-semibold text-gray-800 text-sm truncate block" title={file.filename}>{file.filename}</span>
                                <span className="text-xs text-gray-500 mt-1">
                                  {file.status === 'uploading' ? (
                                    <span className="text-blue-500 font-medium flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> {t('dashboard.processing')}</span>
                                  ) : formatSize(Number(file.size))}
                                </span>
                              </div>
                            </div>
                            <div className="flex gap-2 mt-auto">
                              {file.status === 'uploading' ? (
                                <button onClick={(e) => handleDeleteStuckFile(e, file.id)} className="w-full p-2 text-red-500 bg-red-50 rounded-lg hover:bg-red-100 transition-colors flex items-center justify-center gap-1 text-sm font-medium">
                                  <Trash2 size={14} /> {t('dashboard.stuckDelete')}
                                </button>
                              ) : (
                                <>
                                  <button onClick={(e) => { e.stopPropagation(); openContextMenu(e, file, 'file'); }} className="p-2 text-gray-500 bg-gray-50 border border-gray-100 rounded-lg hover:bg-gray-100 transition-colors">
                                    <MoreVertical size={16} />
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); if (!downloadingFiles.has(file.id)) handleDownload(file.id, file.filename); }}
                                    disabled={downloadingFiles.has(file.id)}
                                    className={`flex-1 flex items-center justify-center gap-1 border border-gray-100 bg-gray-50 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-100 text-gray-700 p-2 rounded-lg font-semibold text-sm transition-colors ${downloadingFiles.has(file.id) ? 'opacity-50 pointer-events-none' : ''}`}
                                  >
                                    {downloadingFiles.has(file.id) ? (<><Loader2 size={14} className="animate-spin" /> {t('dashboard.downloading')}</>) : (<><Download size={14} /> {t('dashboard.download')}</>)}
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
                              <th className="p-3 md:p-4 font-semibold cursor-pointer select-none" onClick={() => handleSort('name')}>
                                <span className="flex items-center gap-1">{t('dashboard.fileName')} <SortIcon field="name" /></span>
                              </th>
                              <th className="p-3 md:p-4 font-semibold hidden sm:table-cell">{t('dashboard.size')}</th>
                              <th className="p-3 md:p-4 font-semibold hidden sm:table-cell cursor-pointer select-none" onClick={() => handleSort('createdAt')}>
                                <span className="flex items-center gap-1">{t('dashboard.createdDate')} <SortIcon field="createdAt" /></span>
                              </th>
                              <th className="p-3 md:p-4 font-semibold text-right">{t('dashboard.options')}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {visibleFiles.map(file => (
                              <tr key={file.id} data-selectable-id={file.id} draggable onDragStart={(e) => handleDragStart(e, file, 'file')}
                                onClick={(e) => handleItemClick(e, file, 'file')}
                                onContextMenu={(e) => file.status === 'complete' && openContextMenu(e, file, 'file')}
                                className={`cursor-pointer transition-colors group ${
                                  selection.isSelected(file.id) ? 'bg-blue-50' : 'hover:bg-gray-50'
                                }`}
                              >
                                <td className="p-3 md:p-4">
                                  <div className="flex items-center gap-3">
                                    <div className="relative flex-shrink-0">
                                      {getFileIcon(file.mimeType, 'w-5 h-5')}
                                      {file.visibility !== 'PRIVATE' && <Globe className="absolute -bottom-1 -right-1 w-3 h-3 text-green-600 bg-white rounded-full p-px" />}
                                    </div>
                                    <div>
                                      <span className="font-medium text-gray-800 block truncate max-w-[150px] sm:max-w-xs md:max-w-sm">{file.filename}</span>
                                      {file.status === 'uploading' && (<span className="text-blue-500 text-xs font-medium flex items-center gap-1 mt-0.5"><Loader2 size={12} className="animate-spin" /> {t('dashboard.listProcessing')}</span>)}
                                      <span className="text-xs text-gray-500 sm:hidden block mt-0.5">{formatSize(Number(file.size))}</span>
                                    </div>
                                  </div>
                                </td>
                                <td className="p-3 md:p-4 text-sm text-gray-600 hidden sm:table-cell">{file.status === 'complete' ? formatSize(Number(file.size)) : '-'}</td>
                                <td className="p-3 md:p-4 text-sm text-gray-500 hidden sm:table-cell">{formatDate(file.createdAt)}</td>
                                <td className="p-3 md:p-4 text-right whitespace-nowrap">
                                  {file.status === 'uploading' ? (
                                    <button onClick={(e) => handleDeleteStuckFile(e, file.id)} className="p-1.5 text-red-500 bg-red-50 hover:bg-red-100 rounded-md transition-colors"><Trash2 size={16} /></button>
                                  ) : (
                                    <div className="flex justify-end gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                                      <button onClick={(e) => { e.stopPropagation(); if (!downloadingFiles.has(file.id)) handleDownload(file.id, file.filename); }}
                                        disabled={downloadingFiles.has(file.id)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-md transition-colors disabled:opacity-50"><Download size={16} /></button>
                                      <button onClick={(e) => { e.stopPropagation(); openContextMenu(e, file, 'file'); }} className="p-1.5 text-gray-500 hover:bg-gray-200 rounded-md transition-opacity"><MoreVertical size={16} /></button>
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

            {hasMore && (<div ref={loadMoreRef} className="py-4 text-center text-gray-400 text-sm">{t('dashboard.loading')}</div>)}
          </div>
        </div>
      </main>

      {/* Context Menu */}
      {contextMenu.isOpen && contextMenu.item && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} itemType={contextMenu.type}
          selectionCount={selection.selectedCount}
          onRename={() => handleOpenDialog('rename')}
          onMove={handleContextMenuMove}
          onShare={() => handleOpenDialog('share')}
          onDetails={() => handleOpenDialog('details')}
          onDelete={handleContextMenuDelete}
        />
      )}

      {/* Selection Action Bar */}
      <SelectionActionBar
        selectedCount={selection.selectedCount}
        onClear={selection.clearSelection}
        variant="dashboard"
        onDelete={handleBatchDelete}
        onMove={handleBatchMoveOpen}
      />

      {/* Dialogs */}
      <CreateFolderDialog isOpen={showCreateFolder} onClose={() => setShowCreateFolder(false)} onConfirm={handleCreateFolder} />

      <RenameDialog isOpen={activeDialog === 'rename'} onClose={() => setActiveDialog('none')}
        initialName={dialogItem ? ('name' in dialogItem ? dialogItem.name : dialogItem.filename) : ''} itemType={dialogItemType}
        onConfirm={async (newName) => { try { await renameItem(dialogItemType, dialogItem!.id, newName); setActiveDialog('none'); fetchContent(); } catch { alert(t('dashboard.renameError')); } }}
      />

      <MoveDialog isOpen={activeDialog === 'move'} onClose={() => setActiveDialog('none')} itemToMove={dialogItem} itemType={dialogItemType}
        onConfirm={async (destFolderId) => { try { await moveItem(dialogItemType, dialogItem!.id, destFolderId); setActiveDialog('none'); fetchContent(); } catch (error: unknown) { alert(getApiErrorMessage(error, t('dashboard.moveError'))); } }}
      />

      {/* Batch move dialog — reuses MoveDialog with a dummy item */}
      <MoveDialog isOpen={activeDialog === 'batchMove'} onClose={() => setActiveDialog('none')}
        itemToMove={{ id: '__batch__', name: `${selection.selectedCount} items`, parentId: null, userId: '', visibility: 'PRIVATE', shareToken: null, createdAt: '', updatedAt: '' } as FolderRecord}
        itemType="folder"
        onConfirm={handleBatchMoveConfirm}
      />

      <ShareDialog isOpen={activeDialog === 'share'} onClose={() => setActiveDialog('none')} onSuccess={fetchContent} item={dialogItem} itemType={dialogItemType} />

      <FileDetailsDialog isOpen={activeDialog === 'details'} onClose={() => setActiveDialog('none')} item={dialogItem} itemType={dialogItemType} />

      <FilePreviewModal fileId={previewFileId} onClose={() => setPreviewFileId(null)} />
    </div>
  );
}
