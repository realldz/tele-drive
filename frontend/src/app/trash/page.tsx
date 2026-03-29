'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FileText, Folder, Trash2, RotateCcw, Clock, Loader2 } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import { useRequireAuth } from '@/hooks/use-require-auth';
import { useSelection } from '@/hooks/use-selection';
import { useDragSelect, DragSelectOverlay } from '@/hooks/use-drag-select';
import Sidebar from '@/components/sidebar';
import ContextMenu from '@/components/context-menu';
import SelectionActionBar from '@/components/selection-action-bar';
import {
  formatSize, fetchTrash as fetchTrashApi,
  restoreFile, permanentDeleteFile, restoreFolder, permanentDeleteFolder,
  getApiErrorMessage, emptyTrash as emptyTrashApi,
} from '@/lib/api';
import type { TrashedFile, TrashedFolder } from '@/lib/types';

export default function TrashPage() {
  const { isReady, token } = useRequireAuth();
  const { t } = useI18n();

  const [trashedFiles, setTrashedFiles] = useState<TrashedFile[]>([]);
  const [trashedFolders, setTrashedFolders] = useState<TrashedFolder[]>([]);
  const [isEmptying, setIsEmptying] = useState(false);
  const [actionIds, setActionIds] = useState<Set<string>>(new Set());

  const selection = useSelection();
  const contentRef = useRef<HTMLDivElement>(null);

  const handleDragSelect = useCallback((ids: string[]) => {
    selection.selectAll(ids);
  }, [selection]);

  const { isDragging, rect: dragRect } = useDragSelect({
    containerRef: contentRef,
    onSelect: handleDragSelect,
  });

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean; x: number; y: number;
    item: TrashedFile | TrashedFolder | null; type: 'file' | 'folder';
  }>({ isOpen: false, x: 0, y: 0, item: null, type: 'file' });

  // Ordered IDs for shift-select
  const orderedIds = useMemo(
    () => [...trashedFolders.map(f => f.id), ...trashedFiles.map(f => f.id)],
    [trashedFolders, trashedFiles],
  );

  // Close context menu on click
  useEffect(() => {
    const handler = () => setContextMenu(prev => ({ ...prev, isOpen: false }));
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  const fetchTrash = useCallback(async () => {
    if (!token) return;
    try {
      const data = await fetchTrashApi();
      setTrashedFiles(data.files);
      setTrashedFolders(data.folders);
    } catch {
      // 401 handled by interceptor
    }
  }, [token]);

  useEffect(() => {
    fetchTrash();
  }, [fetchTrash]);

  // Single-item handlers
  const handleRestoreFile = async (id: string) => {
    if (actionIds.has(id)) return;
    setActionIds(prev => new Set(prev).add(id));
    try {
      await restoreFile(id);
      fetchTrash();
    } catch (error: unknown) {
      alert(getApiErrorMessage(error, 'Error restoring file'));
    } finally {
      setActionIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  const handlePermanentDeleteFile = async (id: string) => {
    if (actionIds.has(id)) return;
    setActionIds(prev => new Set(prev).add(id));
    try {
      await permanentDeleteFile(id);
      fetchTrash();
    } catch (error: unknown) {
      alert(getApiErrorMessage(error, 'Error deleting file'));
    } finally {
      setActionIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  const handleRestoreFolder = async (id: string) => {
    if (actionIds.has(id)) return;
    setActionIds(prev => new Set(prev).add(id));
    try {
      await restoreFolder(id);
      fetchTrash();
    } catch (error: unknown) {
      alert(getApiErrorMessage(error, 'Error restoring folder'));
    } finally {
      setActionIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  const handlePermanentDeleteFolder = async (id: string) => {
    if (actionIds.has(id)) return;
    setActionIds(prev => new Set(prev).add(id));
    try {
      await permanentDeleteFolder(id);
      fetchTrash();
    } catch (error: unknown) {
      alert(getApiErrorMessage(error, 'Error deleting folder'));
    } finally {
      setActionIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  // Batch handlers
  const handleBatchRestore = useCallback(async () => {
    const ids = Array.from(selection.selectedIds);
    for (const id of ids) {
      const isFolder = trashedFolders.some(f => f.id === id);
      try {
        if (isFolder) await restoreFolder(id);
        else await restoreFile(id);
      } catch (error: unknown) {
        alert(getApiErrorMessage(error, 'Error restoring item'));
      }
    }
    selection.clearSelection();
    fetchTrash();
  }, [selection, trashedFolders, fetchTrash]);

  const handleBatchPermanentDelete = useCallback(async () => {
    if (!confirm(t('trash.emptyTrashConfirm'))) return;
    const ids = Array.from(selection.selectedIds);
    for (const id of ids) {
      const isFolder = trashedFolders.some(f => f.id === id);
      try {
        if (isFolder) await permanentDeleteFolder(id);
        else await permanentDeleteFile(id);
      } catch (error: unknown) {
        alert(getApiErrorMessage(error, 'Error deleting item'));
      }
    }
    selection.clearSelection();
    fetchTrash();
  }, [selection, trashedFolders, fetchTrash, t]);

  const handleEmptyTrash = async () => {
    if (!confirm(t('trash.emptyTrashConfirm'))) return;
    setIsEmptying(true);
    try {
      await emptyTrashApi();
      await fetchTrash();
      selection.clearSelection();
    } catch (error: unknown) {
      alert(getApiErrorMessage(error, 'Error emptying trash'));
    } finally {
      setIsEmptying(false);
    }
  };

  // Context menu handlers
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
      handleBatchRestore();
    } else if (contextMenu.item) {
      if (contextMenu.type === 'folder') handleRestoreFolder(contextMenu.item.id);
      else handleRestoreFile(contextMenu.item.id);
    }
  }, [selection.selectedCount, contextMenu, handleBatchRestore]);

  const handleContextMenuPermanentDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setContextMenu(prev => ({ ...prev, isOpen: false }));
    if (selection.selectedCount > 1) {
      handleBatchPermanentDelete();
    } else if (contextMenu.item) {
      if (contextMenu.type === 'folder') {
        if (confirm(t('trash.confirmDeleteFolder'))) handlePermanentDeleteFolder(contextMenu.item.id);
      } else {
        if (confirm(t('trash.confirmDeleteFile'))) handlePermanentDeleteFile(contextMenu.item.id);
      }
    }
  }, [selection.selectedCount, contextMenu, handleBatchPermanentDelete, t]);

  // Item click handler
  const handleItemClick = useCallback((e: React.MouseEvent, item: TrashedFile | TrashedFolder) => {
    selection.handleSelect(item.id, e, orderedIds);
  }, [selection, orderedIds]);

  if (!isReady) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">{t('dashboard.loading')}</div>
      </div>
    );
  }

  const getDaysRemaining = (deletedAt: string) => {
    const deleted = new Date(deletedAt);
    const expiry = new Date(deleted.getTime() + 7 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const remaining = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return Math.max(0, remaining);
  };

  const totalItems = trashedFiles.length + trashedFolders.length;

  return (
    <div className="h-screen bg-white flex overflow-hidden">

      <Sidebar />

      {/* Main Area */}
      <main className="flex-1 flex flex-col min-w-0 bg-white relative">

        {/* Topbar */}
        <header className="h-16 border-b border-gray-100 flex items-center justify-between pl-14 pr-4 md:px-4 lg:px-6 bg-white w-full flex-shrink-0 z-10">
          <div className="flex items-center gap-4">
            <h2 className="text-xl font-bold flex items-center gap-2 text-gray-800">
              <Trash2 className="text-red-500" size={24} />
              {t('trash.title')}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            {totalItems > 0 && (
              <button
                onClick={handleEmptyTrash}
                disabled={isEmptying}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors disabled:opacity-50"
              >
                {isEmptying ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                <span className="hidden sm:inline">{t('trash.emptyTrash')}</span>
              </button>
            )}
            <div className="text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1.5 rounded-full">
              {t('trash.items', { count: String(totalItems) })}
            </div>
          </div>
        </header>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto relative" ref={contentRef} style={{ userSelect: isDragging ? 'none' : undefined }} onClick={(e) => {
          if (e.target === e.currentTarget && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
            selection.clearSelection();
          }
        }}>
          <DragSelectOverlay rect={dragRect} />
          {/* Info banner */}
          <div className="bg-amber-50 px-6 py-3 border-b border-amber-200 text-sm text-amber-800 flex items-center gap-2">
            <Clock size={16} />
            {t('trash.infoBanner')}
          </div>

          <div className="p-6" onClick={(e) => {
            if (e.target === e.currentTarget && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
              selection.clearSelection();
            }
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
                {/* Folders */}
                {trashedFolders.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">{t('trash.folders')}</h3>
                    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
                      <table className="w-full text-left border-collapse">
                        <tbody className="divide-y divide-gray-100">
                          {trashedFolders.map(folder => (
                            <tr key={folder.id} data-selectable-id={folder.id}
                              onClick={(e) => handleItemClick(e, folder)}
                              onContextMenu={(e) => openContextMenu(e, folder, 'folder')}
                              className={`cursor-pointer transition-colors ${
                                selection.isSelected(folder.id) ? 'bg-blue-50' : 'hover:bg-gray-50'
                              }`}
                            >
                              <td className="p-4 flex items-center gap-3">
                                <Folder className="w-6 h-6 text-gray-400 flex-shrink-0" fill="currentColor" opacity={0.5} />
                                <div>
                                  <span className="font-medium text-gray-800 block">{folder.name}</span>
                                  <span className="text-xs text-red-500 mt-0.5 block flex items-center gap-1">
                                    <Clock size={10} /> {t('trash.daysRemaining', { days: String(getDaysRemaining(folder.deletedAt)) })}
                                  </span>
                                </div>
                              </td>
                              <td className="p-4 text-right">
                                <div className="flex justify-end gap-2">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleRestoreFolder(folder.id); }}
                                    disabled={actionIds.has(folder.id) || isEmptying}
                                    className="p-2 text-green-600 bg-green-50 hover:bg-green-100 disabled:opacity-50 disabled:hover:bg-green-50 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
                                  >
                                    {actionIds.has(folder.id) ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
                                    <span className="hidden sm:inline">{t('trash.restore')}</span>
                                  </button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); if (confirm(t('trash.confirmDeleteFolder'))) handlePermanentDeleteFolder(folder.id); }}
                                    disabled={actionIds.has(folder.id) || isEmptying}
                                    className="p-2 text-red-600 bg-red-50 hover:bg-red-100 disabled:opacity-50 disabled:hover:bg-red-50 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
                                  >
                                    {actionIds.has(folder.id) ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                                    <span className="hidden sm:inline">{t('trash.permanentDelete')}</span>
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
                    <h3 className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">{t('trash.files')}</h3>
                    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
                      <table className="w-full text-left border-collapse">
                        <tbody className="divide-y divide-gray-100">
                          {trashedFiles.map(file => (
                            <tr key={file.id} data-selectable-id={file.id}
                              onClick={(e) => handleItemClick(e, file)}
                              onContextMenu={(e) => openContextMenu(e, file, 'file')}
                              className={`cursor-pointer transition-colors ${
                                selection.isSelected(file.id) ? 'bg-blue-50' : 'hover:bg-gray-50'
                              }`}
                            >
                              <td className="p-4 flex items-center gap-3">
                                <FileText className="w-6 h-6 text-gray-400 flex-shrink-0" />
                                <div>
                                  <span className="font-medium text-gray-800 block truncate max-w-[200px] sm:max-w-xs">{file.filename}</span>
                                  <div className="text-xs mt-0.5 flex flex-wrap items-center gap-2">
                                    <span className="text-gray-500 font-medium bg-gray-100 px-1.5 py-0.5 rounded">{formatSize(Number(file.size))}</span>
                                    <span className="text-red-500 flex items-center gap-1">
                                      <Clock size={10} /> {t('trash.daysRemaining', { days: String(getDaysRemaining(file.deletedAt)) })}
                                    </span>
                                  </div>
                                </div>
                              </td>
                              <td className="p-4 text-right whitespace-nowrap">
                                <div className="flex justify-end gap-2">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleRestoreFile(file.id); }}
                                    disabled={actionIds.has(file.id) || isEmptying}
                                    className="p-2 text-green-600 bg-green-50 hover:bg-green-100 disabled:opacity-50 disabled:hover:bg-green-50 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
                                  >
                                    {actionIds.has(file.id) ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
                                    <span className="hidden sm:inline">{t('trash.restore')}</span>
                                  </button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); if (confirm(t('trash.confirmDeleteFile'))) handlePermanentDeleteFile(file.id); }}
                                    disabled={actionIds.has(file.id) || isEmptying}
                                    className="p-2 text-red-600 bg-red-50 hover:bg-red-100 disabled:opacity-50 disabled:hover:bg-red-50 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
                                  >
                                    {actionIds.has(file.id) ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                                    <span className="hidden sm:inline">{t('trash.permanentDelete')}</span>
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

      {/* Context Menu */}
      {contextMenu.isOpen && contextMenu.item && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} itemType={contextMenu.type}
          selectionCount={selection.selectedCount}
          onRestore={handleContextMenuRestore}
          onPermanentDelete={handleContextMenuPermanentDelete}
        />
      )}

      {/* Selection Action Bar */}
      <SelectionActionBar
        selectedCount={selection.selectedCount}
        onClear={selection.clearSelection}
        variant="trash"
        onRestore={handleBatchRestore}
        onPermanentDelete={handleBatchPermanentDelete}
        disabled={isEmptying}
      />
    </div>
  );
}
