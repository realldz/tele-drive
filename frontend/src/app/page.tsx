'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useI18n } from '@/providers/i18n-context';
import { useRequireAuth } from '@/hooks/use-require-auth';
import { useSelection } from '@/hooks/use-selection';
import { useDragSelect, DragSelectOverlay } from '@/hooks/use-drag-select';
import { useUpload } from '@/providers/upload/upload-provider';
import { useDownload } from '@/providers/download-context';
import { useFolderContent } from '@/hooks/use-folder-content';
import { useConflictResolution } from '@/hooks/use-conflict-resolution';
import { useDashboardActions } from '@/hooks/use-dashboard-actions';
import { useDndMove } from '@/hooks/use-dnd-move';
import Sidebar from '@/components/sidebar';
import Breadcrumbs from '@/components/molecules/breadcrumbs';
import ContextMenu from '@/components/molecules/context-menu';
import SelectionActionBar from '@/components/molecules/selection-action-bar';
import Spinner from '@/components/atoms/spinner';
import DashboardTopbar from '@/components/dashboard/dashboard-topbar';
import DashboardContent from '@/components/dashboard/dashboard-content';
import DashboardDialogs from '@/components/dashboard/dashboard-dialogs';
import ConflictDialog from '@/components/organisms/dialogs/conflict-dialog';
import toast from 'react-hot-toast';
import type { FileRecord, FolderRecord } from '@/lib/types';

type ActiveDialog = 'rename' | 'move' | 'share' | 'details' | 'batchMove' | 'none';
type ItemType = 'file' | 'folder';

export default function Dashboard() {
  const { isReady, token } = useRequireAuth();
  const { t, locale } = useI18n();
  const { setCurrentFolderId: setUploadFolderId, setOnUploadSuccess, addFiles, addFolder, resolveConflict, queue } = useUpload();
  const { startDownload } = useDownload();

  const selection = useSelection();
  const content = useFolderContent(token);
  const {
    currentFolderId, setCurrentFolderId, folders, files, setFiles, breadcrumbs,
    isLoadingContent, hasMore, loadMoreRef, searchQuery, setSearchQuery,
    sortField, sortDirection, handleSort, filteredFolders, filteredFiles, orderedIds, fetchContent,
  } = content;

  const conflict = useConflictResolution({ folders, files, fetchContent, resolveConflict, queue, t });
  const { pendingConflict, setPendingConflict, applyToAllRef, buildMoveConflict, handleConflictResolution } = conflict;

  const actions = useDashboardActions({
    t, locale, currentFolderId, fetchContent, selection,
    files, folders, setFiles, startDownload, buildMoveConflict, applyToAllRef,
  });

  const dnd = useDndMove({
    currentFolderId, fetchContent, buildMoveConflict,
    onMoveError: () => toast.error(t('dashboard.moveError')),
  });

  // ── UI-only state ──────────────────────────────────────────────────────────
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>('none');
  const [dialogItem, setDialogItem] = useState<FileRecord | FolderRecord | null>(null);
  const [dialogItemType, setDialogItemType] = useState<ItemType>('file');

  const [showNewMenu, setShowNewMenu] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('viewMode') as 'grid' | 'list') || 'grid';
    }
    return 'grid';
  });
  useEffect(() => { localStorage.setItem('viewMode', viewMode); }, [viewMode]);

  const [showMobileSearch, setShowMobileSearch] = useState(false);

  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean; x: number; y: number;
    item: FileRecord | FolderRecord | null; type: ItemType;
  }>({ isOpen: false, x: 0, y: 0, item: null, type: 'file' });

  const contentRef = useRef<HTMLDivElement>(null);
  const handleDragSelect = useCallback((ids: string[]) => { selection.selectAll(ids); }, [selection]);
  const { isDragging, rect: dragRect } = useDragSelect({ containerRef: contentRef, onSelect: handleDragSelect });

  // ── Effects: menu dismissal + upload wiring ──────────────────────────────────
  useEffect(() => {
    const handler = () => setContextMenu(prev => ({ ...prev, isOpen: false }));
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  useEffect(() => {
    if (!showNewMenu) return;
    const handler = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) setShowNewMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showNewMenu]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { selection.clearSelection(); }, [currentFolderId, selection.clearSelection]);

  useEffect(() => { setUploadFolderId(currentFolderId); }, [currentFolderId, setUploadFolderId]);
  useEffect(() => {
    setOnUploadSuccess(fetchContent);
    return () => setOnUploadSuccess(undefined);
  }, [fetchContent, setOnUploadSuccess]);

  // ── Coordination handlers ────────────────────────────────────────────────────
  const onCreateFolder = useCallback(async (name: string) => {
    const ok = await actions.handleCreateFolder(name);
    if (ok) setShowCreateFolder(false);
  }, [actions]);

  const handleItemClick = useCallback((e: React.MouseEvent, item: FileRecord | FolderRecord, type: ItemType) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      selection.handleSelect(item.id, e, orderedIds);
    } else if (type === 'folder') {
      setCurrentFolderId(item.id);
    } else {
      const file = item as FileRecord;
      if (file.status === 'complete' || file.status === 'buffered') setPreviewFileId(file.id);
    }
  }, [selection, orderedIds, setCurrentFolderId]);

  const openContextMenu = useCallback((e: React.MouseEvent, item: FileRecord | FolderRecord, type: ItemType) => {
    e.preventDefault(); e.stopPropagation();
    if (!selection.isSelected(item.id)) {
      selection.clearSelection();
      selection.handleSelect(item.id, { ...e, ctrlKey: false, metaKey: false, shiftKey: false, stopPropagation: () => { } } as React.MouseEvent, orderedIds);
    }
    setTimeout(() => setContextMenu({ isOpen: true, x: e.clientX, y: e.clientY, item, type }), 0);
  }, [selection, orderedIds]);

  const handleOpenDialog = useCallback((targetDialog: 'rename' | 'move' | 'share' | 'details') => {
    setActiveDialog(targetDialog);
    setDialogItem(contextMenu.item);
    setDialogItemType(contextMenu.type);
    setContextMenu(prev => ({ ...prev, isOpen: false }));
  }, [contextMenu.item, contextMenu.type]);

  const handleContextMenuDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setContextMenu(prev => ({ ...prev, isOpen: false }));
    if (selection.selectedCount > 1) {
      actions.handleBatchDelete();
    } else if (contextMenu.item) {
      if (contextMenu.type === 'folder') actions.handleDeleteFolder(e, contextMenu.item.id);
      else actions.handleDeleteFile(e, contextMenu.item.id);
    }
  }, [selection.selectedCount, contextMenu, actions]);

  const handleContextMenuMove = useCallback(() => {
    setContextMenu(prev => ({ ...prev, isOpen: false }));
    if (selection.selectedCount > 1) setActiveDialog('batchMove');
    else handleOpenDialog('move');
  }, [selection.selectedCount, handleOpenDialog]);

  const batchMoveItem = useMemo(() => ({
    id: '__batch__', name: `${selection.selectedCount} items`,
    parentId: null, userId: '', visibility: 'PRIVATE',
    shareToken: null, s3PublicAccess: false, s3PublicListObjects: false,
    createdAt: '', updatedAt: '',
  } as FolderRecord), [selection.selectedCount]);

  const batchExcludeIds = useMemo(
    () => folders.filter(f => selection.selectedIds.has(f.id)).map(f => f.id),
    [folders, selection.selectedIds],
  );

  if (!isReady) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Spinner size={32} />
      </div>
    );
  }

  return (
    <div className="h-screen bg-white flex overflow-hidden">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 bg-white relative"
        onClick={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).closest('[data-content-area]')) {
            if (!e.ctrlKey && !e.metaKey && !e.shiftKey) selection.clearSelection();
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

        <div className="flex-1 overflow-y-auto relative" ref={contentRef} style={{ userSelect: isDragging ? 'none' : undefined }}>
          <DragSelectOverlay rect={dragRect} />
          <Breadcrumbs items={breadcrumbs} onNavigate={setCurrentFolderId}
            onDragOver={dnd.handleDragOver} onDragLeave={dnd.handleDragLeave} onDrop={dnd.handleDrop}
            dragOverFolderId={dnd.dragOverFolderId} />

          <div className="px-2 py-6 md:px-6" data-content-area onClick={(e) => {
            if (e.target === e.currentTarget && !e.ctrlKey && !e.metaKey && !e.shiftKey) selection.clearSelection();
          }}>
            <DashboardContent
              isLoadingContent={isLoadingContent}
              visibleFolders={filteredFolders} visibleFiles={filteredFiles}
              filteredFoldersCount={filteredFolders.length} filteredFilesCount={filteredFiles.length}
              viewMode={viewMode} searchQuery={searchQuery}
              sortField={sortField} sortDirection={sortDirection} onSort={handleSort}
              selection={selection} downloadingFiles={actions.downloadingFiles} actionLoading={actions.actionLoading}
              dragOverFolderId={dnd.dragOverFolderId}
              hasMore={hasMore} loadMoreRef={loadMoreRef}
              onItemClick={handleItemClick}
              onDragStart={dnd.handleDragStart} onDragOver={dnd.handleDragOver}
              onDragLeave={dnd.handleDragLeave} onDrop={dnd.handleDrop}
              onContextMenu={openContextMenu}
              onDownload={actions.handleDownload} onDeleteStuckFile={actions.handleDeleteStuckFile}
              onRetryBuffer={actions.handleRetryBuffer}
            />
          </div>
        </div>
      </main>

      {contextMenu.isOpen && contextMenu.item && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} itemType={contextMenu.type}
          selectionCount={selection.selectedCount}
          onRename={() => handleOpenDialog('rename')}
          onMove={handleContextMenuMove}
          onShare={() => handleOpenDialog('share')}
          onDetails={() => handleOpenDialog('details')}
          onDelete={handleContextMenuDelete}
          onDownload={actions.handleBatchDownload}
        />
      )}

      <SelectionActionBar
        selectedCount={selection.selectedCount}
        onClear={selection.clearSelection}
        variant="dashboard"
        onDelete={actions.handleBatchDelete}
        onMove={handleContextMenuMove}
        onDownload={actions.handleBatchDownload}
      />

      <DashboardDialogs
        showCreateFolder={showCreateFolder} setShowCreateFolder={setShowCreateFolder}
        onCreateFolder={onCreateFolder}
        createFolderError={actions.createFolderError} setCreateFolderError={actions.setCreateFolderError}
        activeDialog={activeDialog} setActiveDialog={setActiveDialog}
        dialogItem={dialogItem} dialogItemType={dialogItemType}
        fetchContent={fetchContent}
        batchExcludeIds={batchExcludeIds}
        batchMoveItemToMove={batchMoveItem}
        onBatchMoveConfirm={actions.handleBatchMoveConfirm}
        previewFileId={previewFileId} setPreviewFileId={setPreviewFileId}
        onMoveConflict={buildMoveConflict}
      />

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
