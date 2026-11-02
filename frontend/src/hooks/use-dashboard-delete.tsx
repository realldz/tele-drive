'use client';

import { useCallback, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { deleteFile, deleteFolder, restoreFile, restoreFolder } from '@/lib/api';
import { resolveDeletionTargets } from '@/lib/deletion-selection';
import { TOAST_LONG_MS } from '@/lib/constants';
import { useItemActions, type ActionItem } from '@/hooks/use-item-actions';
import type { SelectionState } from '@/hooks/use-selection';

interface Options {
  t: (key: string, vars?: Record<string, string>) => string;
  selection: SelectionState;
  folders: { id: string; parentId: string | null }[];
  files: { id: string; folderId: string | null }[];
  refresh: () => void | Promise<void>;
  removeItems: (ids: string[]) => void;
}

export function useDashboardDelete({ t, selection, folders, files, refresh, removeItems }: Options) {
  const latest = useRef({ refresh, removeItems });
  useEffect(() => { latest.current = { refresh, removeItems }; }, [refresh, removeItems]);
  const operations = useItemActions(t, refresh, removeItems);
  const deleteItems = useCallback(async (items: ActionItem[]) => {
    let targets: ReturnType<typeof resolveDeletionTargets> | undefined;
    const requests = new Map<string, Promise<unknown>>();
    const result = await operations.run(items, async item => {
      targets ??= resolveDeletionTargets(items, folders, files);
      const target = (await targets).get(item.id) ?? item;
      if (!requests.has(target.id)) requests.set(target.id,
        target.type === 'folder' ? deleteFolder(target.id).then(response => {
          const deletedFolders = new Set(response.data.deletedFolderIds ?? [target.id]);
          latest.current.removeItems([
            ...folders.filter(folder => deletedFolders.has(folder.id)).map(folder => folder.id),
            ...files.filter(file => file.folderId && deletedFolders.has(file.folderId)).map(file => file.id),
          ]);
        }) : deleteFile(target.id));
      await requests.get(target.id);
    });
    if (!result) return;
    selection.selectAll(result.failedIds);
    if (items.length === 1 && result.completedIds.length === 1) {
      const item = items[0];
      toast.dismiss(result.toastId);
      toast.success(ti => (
        <span className="flex items-center gap-2">
          {t(item.type === 'folder' ? 'dashboard.deletedFolder' : 'dashboard.deletedFile')}
          <button className="text-blue-500 font-semibold hover:underline" onClick={async () => {
            toast.dismiss(ti.id);
            try {
              await (item.type === 'folder' ? restoreFolder(item.id) : restoreFile(item.id));
              await latest.current.refresh();
            } catch { toast.error(t('dashboard.undoError')); }
          }}>{t('dashboard.undo')}</button>
        </span>
      ), { duration: TOAST_LONG_MS });
    }
  }, [operations, selection, t, folders, files]);

  const handleDeleteFolder = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    return deleteItems([{ id, type: 'folder' }]);
  };
  const handleDeleteFile = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    return deleteItems([{ id, type: 'file' }]);
  };
  const handleBatchDelete = () => {
    const items: ActionItem[] = Array.from(selection.selectedIds).flatMap<ActionItem>(id =>
      folders.some(folder => folder.id === id) ? [{ id, type: 'folder' as const }]
        : files.some(file => file.id === id) ? [{ id, type: 'file' as const }] : []);
    return deleteItems(items);
  };

  return { handleDeleteFolder, handleDeleteFile, handleBatchDelete,
    deletingIds: operations.pendingIds, isDeleting: operations.isBusy, deleteProgress: operations.progress };
}
