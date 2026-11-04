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
 * Reconciles revoke results locally so loaded pages and scroll position survive.
 */
export function useShared({ token, t }: UseSharedArgs) {
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [foldersCursor, setFoldersCursor] = useState<string | null>(null);
  const [filesCursor, setFilesCursor] = useState<string | null>(null);
  const [foldersHasMore, setFoldersHasMore] = useState(false);
  const [filesHasMore, setFilesHasMore] = useState(false);
  const [totalFolders, setTotalFolders] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionIds, setActionIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id drops stale load-more responses after a refresh.
  const requestSeq = useRef(0);
  const translatorRef = useRef(t);
  translatorRef.current = t;

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
      setTotalFolders(res.totalFolders ?? 0);
      setTotalFiles(res.totalFiles ?? 0);
    } catch (err: unknown) {
      if (seq !== requestSeq.current) return;
      setError(getApiErrorMessage(err, translatorRef.current('shared.loadError')));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [token]);

  const loadMoreShared = useCallback(async () => {
    if (loading || loadingMore || (!foldersHasMore && !filesHasMore)) return;
    const seq = ++requestSeq.current;
    setLoadingMore(true);
    try {
      const cursor = foldersCursor ?? filesCursor;
      const res = await listSharedItems({
        cursor: cursor ?? undefined,
        includeTotals: false,
      });
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
      if (seq === requestSeq.current) {
        toast.error(translatorRef.current('shared.loadMoreError'));
      }
    } finally {
      if (seq === requestSeq.current) setLoadingMore(false);
    }
  }, [loading, loadingMore, foldersHasMore, filesHasMore, foldersCursor, filesCursor]);

  /** Revoke every active public mechanism and reconcile each settled result. */
  const revoke = useCallback(
    async (item: FolderRecord | FileRecord, type: 'folder' | 'file') => {
      if (actionIds.has(item.id)) return;
      setActionIds(prev => new Set(prev).add(item.id));
      try {
        const s3Public =
          type === 'folder' && (item as FolderRecord).s3PublicAccess;
        const [linkResult, s3Result] = await Promise.allSettled([
          item.shareToken ? unshareItem(type, item.id) : Promise.resolve(),
          s3Public ? setS3PublicAccess(item.id, false) : Promise.resolve(),
        ]);

        const linkRevoked = !item.shareToken || linkResult.status === 'fulfilled';
        const s3Revoked = !s3Public || s3Result.status === 'fulfilled';
        const fullyRevoked = linkRevoked && s3Revoked;

        if (type === 'folder') {
          if (fullyRevoked) {
            setFolders(prev => prev.filter(folder => folder.id !== item.id));
            setTotalFolders(prev => Math.max(0, prev - 1));
          } else {
            setFolders(prev => prev.map(folder => folder.id === item.id ? {
              ...folder,
              shareToken: linkRevoked ? null : folder.shareToken,
              visibility: linkRevoked ? 'PRIVATE' : folder.visibility,
              s3PublicAccess: s3Revoked ? false : folder.s3PublicAccess,
            } : folder));
          }
        } else if (fullyRevoked) {
          setFiles(prev => prev.filter(file => file.id !== item.id));
          setTotalFiles(prev => Math.max(0, prev - 1));
        }

        const failed = [linkResult, s3Result].find(result => result.status === 'rejected');
        if (failed) {
          toast.error(getApiErrorMessage(
            failed.reason,
            translatorRef.current('shared.revokeError'),
          ));
          return;
        }
        toast.success(translatorRef.current('shared.revoked'));
      } finally {
        setActionIds(prev => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
    },
    [actionIds],
  );

  return {
    folders,
    files,
    foldersHasMore,
    filesHasMore,
    totalFolders,
    totalFiles,
    loading,
    loadingMore,
    error,
    actionIds,
    fetchShared,
    loadMoreShared,
    revoke,
  };
}
