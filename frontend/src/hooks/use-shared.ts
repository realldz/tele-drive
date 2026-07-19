'use client';

import { useState, useCallback, useRef } from 'react';
import {
  listSharedItems,
  unshareItem,
  setS3PublicAccess,
  getApiErrorMessage,
} from '@/lib/api';
import type { FileRecord, FolderRecord } from '@/lib/types';
import toast from 'react-hot-toast';

interface UseSharedArgs {
  token: string | null;
  t: (key: string, vars?: Record<string, string>) => string;
}

/**
 * "Đang chia sẻ" (Shared) data + mutations. Sibling to useTrash: paginated
 * fetch of the user's publicly-shared folders/files (GET /folders/shared) plus
 * an inline revoke that disables every active public mechanism:
 *   - shareToken → unshareItem (drops the public link)
 *   - folder s3PublicAccess → setS3PublicAccess(id, false)
 * Re-fetches after every mutation (simplest correct; optimistic removal is YAGNI).
 */
export function useShared({ token, t }: UseSharedArgs) {
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [foldersCursor, setFoldersCursor] = useState<string | null>(null);
  const [filesCursor, setFilesCursor] = useState<string | null>(null);
  const [foldersHasMore, setFoldersHasMore] = useState(false);
  const [filesHasMore, setFilesHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionIds, setActionIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id drops stale load-more responses after a refresh/revoke.
  const requestSeq = useRef(0);

  const fetchShared = useCallback(async () => {
    if (!token) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    try {
      const res = await listSharedItems();
      if (seq !== requestSeq.current) return;
      setFolders(res.folders);
      setFiles(res.files);
      setFoldersCursor(res.nextFolderCursor);
      setFilesCursor(res.nextFileCursor);
      setFoldersHasMore(res.nextFolderCursor !== null);
      setFilesHasMore(res.nextFileCursor !== null);
    } catch (err: unknown) {
      if (seq !== requestSeq.current) return;
      setError(getApiErrorMessage(err, t('shared.loadError')));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [token, t]);

  const loadMoreShared = useCallback(async () => {
    if (loading || loadingMore || (!foldersHasMore && !filesHasMore)) return;
    const seq = ++requestSeq.current;
    setLoadingMore(true);
    try {
      const cursor = foldersCursor ?? filesCursor;
      const res = await listSharedItems({ cursor: cursor ?? undefined });
      if (seq !== requestSeq.current) return;
      setFolders(prev => {
        const seen = new Set(prev.map(f => f.id));
        return [...prev, ...res.folders.filter(f => !seen.has(f.id))];
      });
      setFiles(prev => {
        const seen = new Set(prev.map(f => f.id));
        return [...prev, ...res.files.filter(f => !seen.has(f.id))];
      });
      setFoldersCursor(res.nextFolderCursor);
      setFilesCursor(res.nextFileCursor);
      setFoldersHasMore(res.nextFolderCursor !== null);
      setFilesHasMore(res.nextFileCursor !== null);
    } catch {
      if (seq === requestSeq.current) toast.error(t('shared.loadMoreError'));
    } finally {
      if (seq === requestSeq.current) setLoadingMore(false);
    }
  }, [loading, loadingMore, foldersHasMore, filesHasMore, foldersCursor, filesCursor, t]);

  /** Revoke every active public mechanism for one item, then re-fetch. */
  const revoke = useCallback(
    async (item: FolderRecord | FileRecord, type: 'folder' | 'file') => {
      if (actionIds.has(item.id)) return;
      setActionIds(prev => new Set(prev).add(item.id));
      try {
        const s3Public =
          type === 'folder' && (item as FolderRecord).s3PublicAccess;
        const results = await Promise.allSettled([
          item.shareToken ? unshareItem(type, item.id) : Promise.resolve(),
          s3Public ? setS3PublicAccess(item.id, false) : Promise.resolve(),
        ]);
        await fetchShared();
        const failed = results.find(r => r.status === 'rejected');
        if (failed) {
          toast.error(getApiErrorMessage(failed.reason, t('shared.revokeError')));
          return;
        }
        toast.success(t('shared.revoked'));
      } finally {
        setActionIds(prev => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
    },
    [actionIds, fetchShared, t],
  );

  return {
    folders,
    files,
    foldersHasMore,
    filesHasMore,
    loading,
    loadingMore,
    error,
    actionIds,
    fetchShared,
    loadMoreShared,
    revoke,
  };
}
