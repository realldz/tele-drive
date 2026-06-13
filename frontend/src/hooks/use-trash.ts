'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  fetchTrashFolders as fetchTrashFoldersApi,
  fetchTrashFiles as fetchTrashFilesApi,
  restoreFile, permanentDeleteFile, restoreFolder, permanentDeleteFolder,
  getApiErrorMessage, getCleanupStatus, startCleanup,
  type TrashCleanupStatus,
} from '@/lib/api';
import { TRASH_EXPIRY_MS, TRASH_CLEANUP_POLL_MS, TOAST_LONG_MS } from '@/lib/constants';
import type { TrashedFile, TrashedFolder } from '@/lib/types';
import toast from 'react-hot-toast';

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
  const [isEmptying, setIsEmptying] = useState(false);
  const [actionIds, setActionIds] = useState<Set<string>>(new Set());
  const [cleanupStatus, setCleanupStatus] = useState<TrashCleanupStatus>({ isCleaning: false });

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

  // Poll cleanup status while emptying
  useEffect(() => {
    if (!cleanupStatus.isCleaning) return;
    const interval = setInterval(async () => {
      try {
        const status = await getCleanupStatus();
        setCleanupStatus(status);
        if (!status.isCleaning) {
          fetchTrash();
          const deletedCount = status.deletedCount ?? 0;
          if (deletedCount > 0) {
            toast.success(t('trash.cleanupComplete', { count: String(deletedCount) }));
          }
        }
      } catch {
        // Ignore polling errors
      }
    }, TRASH_CLEANUP_POLL_MS);
    return () => clearInterval(interval);
  }, [cleanupStatus.isCleaning, fetchTrash, t]);

  const runAction = useCallback(async (id: string, fn: (id: string) => Promise<unknown>, errMsg: string) => {
    if (actionIds.has(id)) return;
    setActionIds(prev => new Set(prev).add(id));
    try {
      await fn(id);
      fetchTrash();
    } catch (error: unknown) {
      alert(getApiErrorMessage(error, errMsg));
    } finally {
      setActionIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    }
  }, [actionIds, fetchTrash]);

  const handleRestoreFile = useCallback((id: string) => runAction(id, restoreFile, 'Error restoring file'), [runAction]);
  const handlePermanentDeleteFile = useCallback((id: string) => runAction(id, permanentDeleteFile, 'Error deleting file'), [runAction]);
  const handleRestoreFolder = useCallback((id: string) => runAction(id, restoreFolder, 'Error restoring folder'), [runAction]);
  const handlePermanentDeleteFolder = useCallback((id: string) => runAction(id, permanentDeleteFolder, 'Error deleting folder'), [runAction]);

  const batchRun = useCallback(async (
    ids: string[],
    folderFn: (id: string) => Promise<unknown>,
    fileFn: (id: string) => Promise<unknown>,
    errMsg: string,
  ) => {
    for (const id of ids) {
      const isFolder = trashedFolders.some(f => f.id === id);
      try {
        await (isFolder ? folderFn(id) : fileFn(id));
      } catch (error: unknown) {
        alert(getApiErrorMessage(error, errMsg));
      }
    }
    fetchTrash();
  }, [trashedFolders, fetchTrash]);

  const handleBatchRestore = useCallback((ids: string[]) =>
    batchRun(ids, restoreFolder, restoreFile, 'Error restoring item'), [batchRun]);

  const handleBatchPermanentDelete = useCallback((ids: string[]) => {
    if (!confirm(t('trash.emptyTrashConfirm'))) return;
    return batchRun(ids, permanentDeleteFolder, permanentDeleteFile, 'Error deleting item');
  }, [batchRun, t]);

  const handleEmptyTrash = useCallback(async () => {
    if (!confirm(t('trash.emptyTrashConfirm'))) return;
    if (cleanupStatus.isCleaning) {
      toast(t('trash.cleanupInProgress'), { icon: '⏳' });
      return;
    }
    setIsEmptying(true);
    try {
      await startCleanup();
      toast.success(t('trash.cleanupStarted'), { duration: TOAST_LONG_MS, icon: '🗑️' });
      setCleanupStatus({ isCleaning: true });
    } catch (error: unknown) {
      alert(getApiErrorMessage(error, 'Error emptying trash'));
      setIsEmptying(false);
    }
  }, [cleanupStatus.isCleaning, t]);

  return {
    trashedFiles, trashedFolders,
    foldersHasMore, filesHasMore, loadingMore, loadMoreTrash,
    isEmptying, actionIds, cleanupStatus,
    fetchTrash,
    handleRestoreFile, handlePermanentDeleteFile,
    handleRestoreFolder, handlePermanentDeleteFolder,
    handleBatchRestore, handleBatchPermanentDelete,
    handleEmptyTrash,
  };
}
