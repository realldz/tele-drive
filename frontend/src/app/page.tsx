'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n, LOCALE_DATE_MAP } from '@/components/i18n-context';
import { useRequireAuth } from '@/hooks/use-require-auth';
import { useLazyLoad } from '@/hooks/use-lazy-load';
import { useSelection } from '@/hooks/use-selection';
import { useDragSelect, DragSelectOverlay } from '@/hooks/use-drag-select';
import Sidebar from '@/components/sidebar';
import Breadcrumbs from '@/components/breadcrumbs';
import ContextMenu from '@/components/context-menu';
import SelectionActionBar from '@/components/selection-action-bar';
import { useUpload } from '@/components/upload-context';
import DashboardTopbar from '@/components/dashboard/dashboard-topbar';
import DashboardContent from '@/components/dashboard/dashboard-content';
import DashboardDialogs from '@/components/dashboard/dashboard-dialogs';
import toast from 'react-hot-toast';
import axios from 'axios';
import {
  fetchFolderContent, fetchBreadcrumbs,
  createFolder, deleteFolder, restoreFolder, deleteFile, restoreFile,
  abortUpload, requestDownloadToken, moveItem, formatBandwidthResetTime, API_URL,
  isConflictError, parseConflictResponse,
} from '@/lib/api';
import ConflictDialog from '@/components/conflict-dialog';
import type { ConflictInfo } from '@/lib/api';
import type { FileRecord, FolderRecord, BreadcrumbItem } from '@/lib/types';
import type { ConflictResolution } from '@/components/upload-context';

type SortField = 'name' | 'createdAt';
type SortDirection = 'asc' | 'desc';

export default function Dashboard() {
  const { isReady, token } = useRequireAuth();
  const { t, locale } = useI18n();
  const { setCurrentFolderId: setUploadFolderId, setOnUploadSuccess, addFiles, addFolder, resolveConflict, queue } = useUpload();

  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>(undefined);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(new Set());
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  // Conflict dialog state
  interface PendingConflict {
    type: 'upload' | 'move';
    itemId: string;
    conflictInfo: ConflictInfo;
    destinationFolderId?: string | null;
    existingItemName?: string;
    existingItemSize?: number;
    existingItemDate?: string;
    incomingSize?: number;
    incomingDate?: string;
  }
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const applyToAllRef = useRef<ConflictResolution | null>(null);

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

  // Watch for upload conflicts in the queue
  useEffect(() => {
    const conflictItem = queue.find(item => item.errorMessage === 'conflict');
    if (conflictItem && !pendingConflict) {
      const fileInfo = conflictItem.conflictInfo;
      if (fileInfo) {
        setPendingConflict({
          type: 'upload',
          itemId: conflictItem.id,
          conflictInfo: {
            type: 'file',
            id: fileInfo.existingItemId,
            name: fileInfo.name,
            suggestedName: '',
            existingItemId: fileInfo.existingItemId,
          },
          existingItemName: fileInfo.name,
          incomingSize: conflictItem.totalBytes,
          incomingDate: new Date().toISOString(),
        });
      }
    }
  }, [queue, pendingConflict]);

  // Handlers
  const [createFolderError, setCreateFolderError] = useState<string | null>(null);

  const handleCreateFolder = useCallback(async (name: string) => {
    setCreateFolderError(null);
    try {
      await createFolder(name, currentFolderId);
      setShowCreateFolder(false);
      fetchContent();
    } catch (error: unknown) {
      if (isConflictError(error)) {
        setCreateFolderError(t('createFolder.nameConflict'));
      } else {
        setCreateFolderError(t('dashboard.createFolderError'));
      }
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
          <button onClick={async () => { toast.dismiss(ti.id); try { await restoreFolder(id); fetchContent(); } catch { toast.error(t('dashboard.undoError')); } }}
            className="text-blue-500 font-semibold text-sm hover:underline ml-2 cursor-pointer">{t('dashboard.undo')}</button>
        </span>
      ), { duration: 5000 });
    } catch (error: unknown) { toast.error(t('dashboard.deleteStuckError')); }
  }, [fetchContent, t]);

  const handleDeleteFile = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await deleteFile(id);
      fetchContent();
      toast.success((ti) => (
        <span className="flex items-center gap-2">
          {t('dashboard.deletedFile')}
          <button onClick={async () => { toast.dismiss(ti.id); try { await restoreFile(id); fetchContent(); } catch { toast.error(t('dashboard.undoError')); } }}
            className="text-blue-500 font-semibold text-sm hover:underline ml-2 cursor-pointer">{t('dashboard.undo')}</button>
        </span>
      ), { duration: 5000 });
    } catch (error: unknown) { toast.error(t('dashboard.deleteStuckError')); }
  }, [fetchContent, t]);

  const handleDeleteStuckFile = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try { await abortUpload(id); fetchContent(); }
    catch (error: unknown) { toast.error(t('dashboard.deleteStuckError')); }
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
        toast.error(t('dashboard.deleteStuckError'));
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
      const type: 'file' | 'folder' = isFolder ? 'folder' : 'file';

      const applyStored = applyToAllRef.current;
      if (applyStored) {
        const action = applyStored === 'skip' ? 'skip' : applyStored === 'overwrite' ? 'overwrite' : applyStored === 'keepBoth' ? 'rename' : 'merge';
        try {
          await moveItem(type, id, destFolderId, action);
        } catch (error: unknown) {
          if (!isConflictError(error)) {
            toast.error(t('dashboard.moveError'));
          }
        }
        continue;
      }

      try {
        await moveItem(type, id, destFolderId);
      } catch (error: unknown) {
        if (isConflictError(error)) {
          const conflict = parseConflictResponse(error);
          if (!conflict) continue;
          const existingItem = isFolder
            ? folders.find(f => f.id === conflict.existingItemId)
            : files.find(f => f.id === conflict.existingItemId);
          const movingItem = isFolder
            ? folders.find(f => f.id === id)
            : files.find(f => f.id === id);

          setPendingConflict({
            type: 'move',
            itemId: id,
            conflictInfo: conflict,
            destinationFolderId: destFolderId,
            existingItemName: type === 'folder' && existingItem ? (existingItem as FolderRecord).name : type === 'file' && existingItem ? (existingItem as FileRecord).filename : conflict.name,
            existingItemDate: existingItem?.updatedAt,
            incomingSize: type === 'file' && movingItem ? (movingItem as FileRecord).size : undefined,
            incomingDate: movingItem?.updatedAt,
          });
          return;
        }
        toast.error(t('dashboard.moveError'));
      }
    }

    selection.clearSelection();
    setActiveDialog('none');
    fetchContent();
  }, [selection, folders, files, fetchContent, t]);

  // Resolve conflict from dialog — works for both move and upload conflicts
  const handleConflictResolution = useCallback(async (action: ConflictResolution, applyToAll: boolean) => {
    if (!pendingConflict) return;
    const { type, itemId, destinationFolderId } = pendingConflict;

    if (applyToAll) {
      applyToAllRef.current = action;
    }

    if (type === 'move') {
      const backendAction = action === 'skip' ? 'skip' : action === 'overwrite' ? 'overwrite' : action === 'keepBoth' ? 'rename' : 'merge';
      try {
        const itemType = folders.some(f => f.id === itemId) ? 'folder' : 'file';
        await moveItem(itemType, itemId, destinationFolderId ?? null, backendAction);
        if (action !== 'skip') {
          toast.success(
            action === 'overwrite' ? t('conflict.overwriteSuccess')
              : action === 'keepBoth' ? t('conflict.renamed')
              : t('conflict.merged'),
          );
        } else {
          toast.success(t('conflict.skipped'));
        }
        fetchContent();
      } catch (error: unknown) {
        if (!isConflictError(error)) {
          toast.error(t('dashboard.moveError'));
        }
      }
    } else if (type === 'upload') {
      await resolveConflict(itemId, action);
    }

    setPendingConflict(null);
  }, [pendingConflict, folders, fetchContent, resolveConflict, t]);

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

    try {
      await moveItem(draggedItem.type, draggedItem.id, targetFolderId);
      fetchContent();
    } catch (error: unknown) {
      if (isConflictError(error)) {
        const conflict = parseConflictResponse(error);
        if (!conflict) return;
        const existingItem = draggedItem.type === 'folder'
          ? folders.find(f => f.id === conflict.existingItemId)
          : files.find(f => f.id === conflict.existingItemId);
        const movingItem = draggedItem.type === 'folder'
          ? folders.find(f => f.id === draggedItem.id)
          : files.find(f => f.id === draggedItem.id);

        setPendingConflict({
          type: 'move',
          itemId: draggedItem.id,
          conflictInfo: conflict,
          destinationFolderId: targetFolderId,
          existingItemName: draggedItem.type === 'folder' && existingItem ? (existingItem as FolderRecord).name : draggedItem.type === 'file' && existingItem ? (existingItem as FileRecord).filename : conflict.name,
          existingItemDate: existingItem?.updatedAt,
          incomingSize: draggedItem.type === 'file' && movingItem ? (movingItem as FileRecord).size : undefined,
          incomingDate: movingItem?.updatedAt,
        });
        return;
      }
      toast.error(t('dashboard.moveError'));
    }
    setDraggedItem(null);
  };

  const openContextMenu = useCallback((e: React.MouseEvent, item: FileRecord | FolderRecord, type: 'file' | 'folder') => {
    e.preventDefault(); e.stopPropagation();
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
      selection.handleSelect(item.id, e, orderedIds);
    } else {
      if (type === 'folder') {
        setCurrentFolderId(item.id);
      } else {
        const file = item as FileRecord;
        if (file.status === 'complete') setPreviewFileId(file.id);
      }
    }
  }, [selection, orderedIds]);

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

  // Batch move dummy item (stable reference)
  const batchMoveItem = useMemo(() => ({
    id: '__batch__', name: `${selection.selectedCount} items`,
    parentId: null, userId: '', visibility: 'PRIVATE',
    shareToken: null, createdAt: '', updatedAt: '',
  } as FolderRecord), [selection.selectedCount]);

  const batchExcludeIds = useMemo(
    () => folders.filter(f => selection.selectedIds.has(f.id)).map(f => f.id),
    [folders, selection.selectedIds],
  );

  if (!isReady) {
    return (<div className="min-h-screen bg-gray-50 flex items-center justify-center"><Loader2 className="animate-spin text-blue-500" size={32} /></div>);
  }

  return (
    <div className="h-screen bg-white flex overflow-hidden">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 bg-white relative"
        onClick={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).closest('[data-content-area]')) {
            if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
              selection.clearSelection();
            }
          }
        }}
      >

        <DashboardTopbar
          showMobileSearch={showMobileSearch} setShowMobileSearch={setShowMobileSearch}
          searchQuery={searchQuery} setSearchQuery={setSearchQuery}
          showNewMenu={showNewMenu} setShowNewMenu={setShowNewMenu}
          newMenuRef={newMenuRef} fileInputRef={fileInputRef} folderInputRef={folderInputRef}
          currentFolderId={currentFolderId}
          addFiles={addFiles} addFolder={addFolder}
          viewMode={viewMode} setViewMode={setViewMode}
          setShowCreateFolder={setShowCreateFolder}
        />

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto relative" ref={contentRef} style={{ userSelect: isDragging ? 'none' : undefined }}>
          <DragSelectOverlay rect={dragRect} />
          <Breadcrumbs items={breadcrumbs} onNavigate={setCurrentFolderId} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} dragOverFolderId={dragOverFolderId} />

          <div className="px-2 py-6 md:px-6" data-content-area onClick={(e) => {
            if (e.target === e.currentTarget && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
              selection.clearSelection();
            }
          }}>
            <DashboardContent
              isLoadingContent={isLoadingContent}
              folders={folders} files={files}
              visibleFolders={visibleFolders} visibleFiles={visibleFiles}
              filteredFoldersCount={filteredFolders.length} filteredFilesCount={filteredFiles.length}
              viewMode={viewMode} searchQuery={searchQuery}
              sortField={sortField} sortDirection={sortDirection} onSort={handleSort}
              selection={selection} downloadingFiles={downloadingFiles}
              dragOverFolderId={dragOverFolderId}
              hasMore={hasMore} loadMoreRef={loadMoreRef}
              onItemClick={handleItemClick}
              onDragStart={handleDragStart} onDragOver={handleDragOver}
              onDragLeave={handleDragLeave} onDrop={handleDrop}
              onContextMenu={openContextMenu}
              onDownload={handleDownload} onDeleteStuckFile={handleDeleteStuckFile}
            />
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
      <DashboardDialogs
        showCreateFolder={showCreateFolder} setShowCreateFolder={setShowCreateFolder}
        onCreateFolder={handleCreateFolder}
        createFolderError={createFolderError} setCreateFolderError={setCreateFolderError}
        activeDialog={activeDialog} setActiveDialog={setActiveDialog}
        dialogItem={dialogItem} dialogItemType={dialogItemType}
        fetchContent={fetchContent}
        batchExcludeIds={batchExcludeIds}
        batchMoveItemToMove={batchMoveItem}
        onBatchMoveConfirm={handleBatchMoveConfirm}
        previewFileId={previewFileId} setPreviewFileId={setPreviewFileId}
        onMoveConflict={(itemId, itemType, error) => {
          const conflict = parseConflictResponse(error);
          if (!conflict) return;
          const existingItem = itemType === 'folder'
            ? folders.find(f => f.id === conflict.existingItemId)
            : files.find(f => f.id === conflict.existingItemId);
          const movingItem = itemType === 'folder'
            ? folders.find(f => f.id === itemId)
            : files.find(f => f.id === itemId);

          setPendingConflict({
            type: 'move',
            itemId,
            conflictInfo: conflict,
            existingItemName: itemType === 'folder' && existingItem ? (existingItem as FolderRecord).name : itemType === 'file' && existingItem ? (existingItem as FileRecord).filename : conflict.name,
            existingItemDate: existingItem?.updatedAt,
            incomingSize: itemType === 'file' && movingItem ? (movingItem as FileRecord).size : undefined,
            incomingDate: movingItem?.updatedAt,
          });
        }}
      />

      {/* Conflict Dialog */}
      {pendingConflict && (
        <ConflictDialog
          isOpen={!!pendingConflict}
          onClose={() => setPendingConflict(null)}
          conflictType={pendingConflict.conflictInfo.type}
          incomingName={pendingConflict.conflictInfo.name}
          incomingSize={pendingConflict.incomingSize}
          incomingDate={pendingConflict.incomingDate}
          existingName={pendingConflict.existingItemName || pendingConflict.conflictInfo.name}
          existingSize={pendingConflict.existingItemSize}
          existingDate={pendingConflict.existingItemDate}
          onOverwrite={(applyToAll) => handleConflictResolution('overwrite', applyToAll)}
          onKeepBoth={(applyToAll) => handleConflictResolution('keepBoth', applyToAll)}
          onMerge={(applyToAll) => handleConflictResolution('merge', applyToAll)}
          onSkip={(applyToAll) => handleConflictResolution('skip', applyToAll)}
        />
      )}
    </div>
  );
}
