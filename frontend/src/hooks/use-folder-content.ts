'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  fetchBreadcrumbs,
  fetchFolderContentInitial,
  fetchFolderContentNextPage,
} from '@/lib/api';
import { useBufferSync } from '@/hooks/use-buffer-sync';
import { LOAD_MORE_ROOT_MARGIN, UPLOAD_POLL_INTERVAL_MS } from '@/lib/constants';
import type { FileRecord, FolderRecord, BreadcrumbItem } from '@/lib/types';

export type SortField = 'name' | 'createdAt';
export type SortDirection = 'asc' | 'desc';

/**
 * Data layer for the dashboard: folder/file content, cursor pagination,
 * sorting, client-side search filtering, and the load-more observer.
 */
export function useFolderContent(token: string | null) {
  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>(undefined);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [files, setFiles] = useState<FileRecord[]>([]);

  // Poll status of buffered files
  useBufferSync(files, (id, newStatus) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, status: newStatus } : f));
  });

  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [isLoadMore, setIsLoadMore] = useState(false);
  const [hasMoreFolders, setHasMoreFolders] = useState(true);
  const [hasMoreFiles, setHasMoreFiles] = useState(true);
  const nextFileCursor = useRef<string | null>(null);
  const nextFolderCursor = useRef<string | null>(null);

  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const handleSort = useCallback((field: SortField) => {
    setSortDirection(prev => sortField === field ? (prev === 'asc' ? 'desc' : 'asc') : 'desc');
    setSortField(field);
  }, [sortField]);

  // Global search moved to use-global-search (search mode); browse mode renders
  // raw folder content. No client-side cosmetic filter here anymore.
  const orderedIds = useMemo(
    () => [...folders.map(f => f.id), ...files.map(f => f.id)],
    [folders, files],
  );

  const hasMore = hasMoreFolders || hasMoreFiles;
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    nextFileCursor.current = null;
    nextFolderCursor.current = null;
    setHasMoreFolders(true);
    setHasMoreFiles(true);
    // Xoá nội dung thư mục cũ ngay khi đổi folder — nếu giữ lại, điều kiện
    // spinner (list rỗng) fail và dashboard chỉ hiện dòng "Loading..." ở đáy.
    // Clear để state rỗng → spinner toàn trang hiện nhất quán trong lúc fetch.
    setFolders([]);
    setFiles([]);
  }, [currentFolderId]);

  const fetchContent = useCallback(async (isLoadMoreCall = false) => {
    if (!token) return;
    if (!isLoadMoreCall) setIsLoadingContent(true);
    if (isLoadMoreCall) setIsLoadMore(true);
    try {
      const data = isLoadMoreCall
        ? await fetchFolderContentNextPage(
            currentFolderId,
            nextFolderCursor.current,
            nextFileCursor.current,
            undefined,
            sortField,
            sortDirection,
          )
        : await fetchFolderContentInitial(currentFolderId, undefined, sortField, sortDirection);

      if (isLoadMoreCall) {
        setFolders(prev => {
          const existingIds = new Set(prev.map(f => f.id));
          return [...prev, ...data.folders.filter(f => !existingIds.has(f.id))];
        });
        setFiles(prev => {
          const existingIds = new Set(prev.map(f => f.id));
          return [...prev, ...data.files.filter(f => !existingIds.has(f.id))];
        });
      } else {
        setFolders(data.folders);
        setFiles(data.files);
      }
      setHasMoreFolders(data.nextFolderCursor !== null);
      setHasMoreFiles(data.nextFileCursor !== null);
      nextFileCursor.current = data.nextFileCursor;
      nextFolderCursor.current = data.nextFolderCursor;
      if (!isLoadMoreCall && currentFolderId) {
        const bc = await fetchBreadcrumbs(currentFolderId);
        setBreadcrumbs(bc);
      }
      if (!isLoadMoreCall && !currentFolderId) {
        setBreadcrumbs([]);
      }
    } catch {
      // 401 handled by axios interceptor
    } finally {
      setIsLoadingContent(false);
      setIsLoadMore(false);
    }
  }, [currentFolderId, token, sortField, sortDirection]);

  const handleLoadMore = useCallback(() => {
    fetchContent(true);
  }, [fetchContent]);

  useEffect(() => {
    if (!loadMoreRef.current) return;
    if (observerRef.current) observerRef.current.disconnect();

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingContent && !isLoadMore) {
          handleLoadMore();
        }
      },
      { rootMargin: LOAD_MORE_ROOT_MARGIN },
    );

    observerRef.current.observe(loadMoreRef.current);
    return () => { if (observerRef.current) observerRef.current.disconnect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, isLoadingContent, isLoadMore]);

  useEffect(() => { fetchContent(false); }, [fetchContent]);

  // Polling while any file is uploading (browse mode; global search is a
  // separate hook and never drives this dataset).
  useEffect(() => {
    const hasUploading = files.some(f => f.status === 'uploading');
    if (hasUploading) {
      const id = setInterval(fetchContent, UPLOAD_POLL_INTERVAL_MS);
      return () => clearInterval(id);
    }
  }, [files, fetchContent]);

  return {
    currentFolderId, setCurrentFolderId,
    folders, setFolders,
    files, setFiles,
    breadcrumbs,
    isLoadingContent,
    hasMore, loadMoreRef,
    sortField, sortDirection, handleSort,
    orderedIds,
    fetchContent,
  };
}
