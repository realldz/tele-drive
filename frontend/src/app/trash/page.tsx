'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Trash2, Clock, Loader2, FileSearch } from 'lucide-react';
import { useI18n } from '@/providers/i18n-context';
import { useRequireAuth } from '@/hooks/use-require-auth';
import { useSelection } from '@/hooks/use-selection';
import { useDragSelect, DragSelectOverlay } from '@/hooks/use-drag-select';
import { useTrash } from '@/hooks/use-trash';
import Sidebar from '@/components/sidebar';
import ContextMenu from '@/components/molecules/context-menu';
import SelectionActionBar from '@/components/molecules/selection-action-bar';
import TrashTable from '@/components/organisms/trash/trash-table';
import type { TrashedFile, TrashedFolder } from '@/lib/types';

export default function TrashPage() {
  const { isReady, token } = useRequireAuth();
  const { t } = useI18n();

  const trash = useTrash({ token, t });
  const {
    trashedFiles, trashedFolders,
    foldersHasMore, filesHasMore, loadingMore, loadMoreTrash,
    isEmptying, actionIds, cleanupStatus, fetchTrash,
    handleRestoreFile, handlePermanentDeleteFile,
    handleRestoreFolder, handlePermanentDeleteFolder,
    handleBatchRestore, handleBatchPermanentDelete, handleEmptyTrash,
  } = trash;

  const selection = useSelection();
  const contentRef = useRef<HTMLDivElement>(null);

  const handleDragSelect = useCallback((ids: string[]) => { selection.selectAll(ids); }, [selection]);
  const { isDragging, rect: dragRect } = useDragSelect({ containerRef: contentRef, onSelect: handleDragSelect });

  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean; x: number; y: number;
    item: TrashedFile | TrashedFolder | null; type: 'file' | 'folder';
  }>({ isOpen: false, x: 0, y: 0, item: null, type: 'file' });

  const orderedIds = useMemo(
    () => [...trashedFolders.map(f => f.id), ...trashedFiles.map(f => f.id)],
    [trashedFolders, trashedFiles],
  );

  useEffect(() => {
    const handler = () => setContextMenu(prev => ({ ...prev, isOpen: false }));
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  useEffect(() => {
    fetchTrash();
    selection.clearSelection();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- stable on mount

  const openContextMenu = useCallback((e: React.MouseEvent, item: TrashedFile | TrashedFolder, type: 'file' | 'folder') => {
    e.preventDefault(); e.stopPropagation();
    if (!selection.isSelected(item.id)) {
      selection.clearSelection();
      selection.handleSelect(item.id, { ...e, ctrlKey: false, metaKey: false, shiftKey: false, stopPropagation: () => {} } as React.MouseEvent, orderedIds);
    }
    setTimeout(() => setContextMenu({ isOpen: true, x: e.clientX, y: e.clientY, item, type }), 0);
  }, [selection, orderedIds]);

  const handleContextMenuRestore = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setContextMenu(prev => ({ ...prev, isOpen: false }));
    if (selection.selectedCount > 1) {
      handleBatchRestore(Array.from(selection.selectedIds));
      selection.clearSelection();
    } else if (contextMenu.item) {
      if (contextMenu.type === 'folder') handleRestoreFolder(contextMenu.item.id);
      else handleRestoreFile(contextMenu.item.id);
    }
  }, [selection, contextMenu, handleBatchRestore, handleRestoreFolder, handleRestoreFile]);

  const handleContextMenuPermanentDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setContextMenu(prev => ({ ...prev, isOpen: false }));
    if (selection.selectedCount > 1) {
      handleBatchPermanentDelete(Array.from(selection.selectedIds));
      selection.clearSelection();
    } else if (contextMenu.item) {
      if (contextMenu.type === 'folder') {
        if (confirm(t('trash.confirmDeleteFolder'))) handlePermanentDeleteFolder(contextMenu.item.id);
      } else {
        if (confirm(t('trash.confirmDeleteFile'))) handlePermanentDeleteFile(contextMenu.item.id);
      }
    }
  }, [selection, contextMenu, handleBatchPermanentDelete, handlePermanentDeleteFolder, handlePermanentDeleteFile, t]);

  const handleItemClick = useCallback((e: React.MouseEvent, item: TrashedFile | TrashedFolder) => {
    selection.handleSelect(item.id, e, orderedIds);
  }, [selection, orderedIds]);

  const handleBatchRestoreClick = useCallback(() => {
    handleBatchRestore(Array.from(selection.selectedIds));
    selection.clearSelection();
  }, [handleBatchRestore, selection]);

  const handleBatchDeleteClick = useCallback(() => {
    handleBatchPermanentDelete(Array.from(selection.selectedIds));
    selection.clearSelection();
  }, [handleBatchPermanentDelete, selection]);

  if (!isReady) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">{t('dashboard.loading')}</div>
      </div>
    );
  }

  const totalItems = trashedFiles.length + trashedFolders.length;

  return (
    <div className="h-screen bg-white flex overflow-hidden">
      <Sidebar />

      <main className="flex-1 flex flex-col min-w-0 bg-white relative">
        <header className="h-16 border-b border-gray-100 flex items-center justify-between pl-14 pr-4 md:px-4 lg:px-6 bg-white w-full flex-shrink-0 z-10">
          <h2 className="text-xl font-bold flex items-center gap-2 text-gray-800">
            <Trash2 className="text-red-500" size={24} />
            {t('trash.title')}
          </h2>
          <div className="flex items-center gap-3">
            {totalItems > 0 && (
              <button
                onClick={handleEmptyTrash}
                disabled={isEmptying || cleanupStatus.isCleaning}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors disabled:opacity-50"
              >
                {(isEmptying || cleanupStatus.isCleaning) ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                <span className="hidden sm:inline">{t('trash.emptyTrash')}</span>
              </button>
            )}
            <div className="text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1.5 rounded-full">
              {t('trash.items', { count: String(totalItems) })}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto relative" ref={contentRef} style={{ userSelect: isDragging ? 'none' : undefined }}>
          <DragSelectOverlay rect={dragRect} />
          <div className="bg-amber-50 px-6 py-3 border-b border-amber-200 text-sm text-amber-800 flex items-center gap-2">
            <Clock size={16} />
            {t('trash.infoBanner')}
          </div>

          <div className="p-6" onClick={(e) => {
            if (e.target === e.currentTarget && !e.ctrlKey && !e.metaKey && !e.shiftKey) selection.clearSelection();
          }}>
            {totalItems === 0 ? (
              <div className="text-center py-20 bg-gray-50 rounded-2xl border-2 border-dashed border-gray-200 mt-4">
                <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mx-auto mb-4 shadow-sm border border-gray-100">
                  <Trash2 className="text-gray-300" size={32} />
                </div>
                <p className="text-gray-500 font-medium tracking-wide">{t('trash.empty')}</p>
              </div>
            ) : (
              <div className="space-y-8">
                <div>
                  <h3 className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">{t('trash.files')}</h3>
                  <TrashTable
                    folders={trashedFolders} files={trashedFiles}
                    selection={selection} actionIds={actionIds}
                    isEmptying={isEmptying} isCleaning={cleanupStatus.isCleaning}
                    onItemClick={handleItemClick} onContextMenu={openContextMenu}
                    onRestoreFolder={handleRestoreFolder} onPermanentDeleteFolder={handlePermanentDeleteFolder}
                    onRestoreFile={handleRestoreFile} onPermanentDeleteFile={handlePermanentDeleteFile}
                  />
                </div>

                {(foldersHasMore || filesHasMore) && (
                  <div className="py-4 text-center">
                    {loadingMore ? (
                      <Loader2 className="animate-spin text-blue-500 mx-auto" size={20} />
                    ) : (
                      <button onClick={loadMoreTrash} className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-600 transition-colors flex items-center gap-2 mx-auto">
                        <FileSearch size={16} /> {t('dashboard.loadMore')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>

      {contextMenu.isOpen && contextMenu.item && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} itemType={contextMenu.type}
          selectionCount={selection.selectedCount}
          onRestore={handleContextMenuRestore}
          onPermanentDelete={handleContextMenuPermanentDelete}
        />
      )}

      <SelectionActionBar
        selectedCount={selection.selectedCount}
        onClear={selection.clearSelection}
        variant="trash"
        onRestore={handleBatchRestoreClick}
        onPermanentDelete={handleBatchDeleteClick}
        disabled={isEmptying || cleanupStatus.isCleaning}
      />
    </div>
  );
}
