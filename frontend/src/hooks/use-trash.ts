'use client';

import { useState, useCallback } from 'react';
import {
  fetchTrashFolders as fetchTrashFoldersApi,
  fetchTrashFiles as fetchTrashFilesApi,
  restoreFile, permanentDeleteFile, restoreFolder, permanentDeleteFolder,
} from '@/lib/api';
import { TRASH_EXPIRY_MS } from '@/lib/constants';
import type { TrashedFile, TrashedFolder } from '@/lib/types';
import { useItemActions, type ActionItem } from '@/hooks/use-item-actions';
import { useTrashCleanup } from '@/hooks/use-trash-cleanup';

interface UseTrashArgs {
  token: string | null;
  t: (key: string, vars?: Record<string, string>) => string;
}

/** Days left before a trashed item is purged (7-day retention). */
export function getDaysRemaining(deletedAt: string): number {
  const expiry = new Date(deletedAt).getTime() + TRASH_EXPIRY_MS;
  const remaining = Math.ceil((expiry - Date.now()) / (1000 * 60 * 60 * 24));
  return Math.max(0, remaining);
}

/**
 * Trash data + mutations: paginated fetch of trashed files/folders, single +
 * batch restore/permanent-delete, and the async empty-trash cleanup poll.
 */
export function useTrash({ token, t }: UseTrashArgs) {
  const [trashedFiles, setTrashedFiles] = useState<TrashedFile[]>([]);
  const [trashedFolders, setTrashedFolders] = useState<TrashedFolder[]>([]);
  const [foldersCursor, setFoldersCursor] = useState<string | null>(null);
  const [filesCursor, setFilesCursor] = useState<string | null>(null);
  const [foldersHasMore, setFoldersHasMore] = useState(true);
  const [filesHasMore, setFilesHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const fetchTrash = useCallback(async () => {
    if (!token) return;
    try {
      const [foldersRes, filesRes] = await Promise.all([
        fetchTrashFoldersApi(),
        fetchTrashFilesApi(),
      ]);
      setTrashedFolders(foldersRes.data);
      setTrashedFiles(filesRes.data);
      setFoldersCursor(foldersRes.nextCursor);
      setFilesCursor(filesRes.nextCursor);
      setFoldersHasMore(foldersRes.nextCursor !== null);
      setFilesHasMore(filesRes.nextCursor !== null);
    } catch {
      // 401 handled by interceptor
    }
  }, [token]);

  const loadMoreTrash = useCallback(async () => {
    if (loadingMore || (!foldersHasMore && !filesHasMore)) return;
    setLoadingMore(true);
    try {
      const fetches: Promise<unknown>[] = [];
      if (foldersHasMore && foldersCursor) {
        fetches.push(fetchTrashFoldersApi(foldersCursor).then(res => {
          setTrashedFolders(prev => [...prev, ...res.data]);
          setFoldersCursor(res.nextCursor);
          setFoldersHasMore(res.nextCursor !== null);
        }));
      }
      if (filesHasMore && filesCursor) {
        fetches.push(fetchTrashFilesApi(filesCursor).then(res => {
          setTrashedFiles(prev => [...prev, ...res.data]);
          setFilesCursor(res.nextCursor);
          setFilesHasMore(res.nextCursor !== null);
        }));
      }
      await Promise.all(fetches);
    } catch {
      // Ignore errors on load more
    } finally { setLoadingMore(false); }
  }, [loadingMore, foldersHasMore, filesHasMore, foldersCursor, filesCursor]);

  const cleanup = useTrashCleanup(token, t, fetchTrash);
  const operations = useItemActions(t, fetchTrash, ids => {
    const removed = new Set(ids);
    setTrashedFolders(previous => previous.filter(item => !removed.has(item.id)));
    setTrashedFiles(previous => previous.filter(item => !removed.has(item.id)));
  });
  const blocked = cleanup.isEmptying || cleanup.cleanupStatus.isCleaning;
  const run = async (items: ActionItem[], restore: boolean) => {
    if (blocked) return null;
    return operations.run(items, item => {
      if (restore) return item.type === 'folder' ? restoreFolder(item.id) : restoreFile(item.id);
      return item.type === 'folder' ? permanentDeleteFolder(item.id) : permanentDeleteFile(item.id);
    });
  };
  const itemsFor = (ids: string[]): ActionItem[] => ids.map(id => ({
    id, type: trashedFolders.some(folder => folder.id === id) ? 'folder' : 'file',
  }));
  const handleRestoreFile = (id: string) => run([{ id, type: 'file' }], true);
  const handleRestoreFolder = (id: string) => run([{ id, type: 'folder' }], true);
  const handlePermanentDeleteFile = (id: string) => run([{ id, type: 'file' }], false);
  const handlePermanentDeleteFolder = (id: string) => run([{ id, type: 'folder' }], false);
  const handleBatchRestore = (ids: string[]) => run(itemsFor(ids), true);
  const handleBatchPermanentDelete = (ids: string[]) => {
    if (blocked || operations.isBusy || !confirm(t('trash.confirmDeleteSelected', { count: String(ids.length) }))) return Promise.resolve(null);
    return run(itemsFor(ids), false);
  };
  const handleEmptyTrash = () => { if (!operations.isBusy) return cleanup.start(); };

  return {
    trashedFiles, trashedFolders,
    foldersHasMore, filesHasMore, loadingMore, loadMoreTrash,
    isEmptying: cleanup.isEmptying, actionIds: operations.pendingIds, cleanupStatus: cleanup.cleanupStatus,
    isActing: operations.isBusy, statusError: cleanup.statusError, retryStatus: cleanup.retryStatus,
    fetchTrash,
    handleRestoreFile, handlePermanentDeleteFile,
    handleRestoreFolder, handlePermanentDeleteFolder,
    handleBatchRestore, handleBatchPermanentDelete,
    handleEmptyTrash,
  };
}
