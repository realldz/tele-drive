'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import toast from 'react-hot-toast';
import { useI18n } from '@/providers/i18n-context';
import { useSelection } from '@/hooks/use-selection';
import { useDownload } from '@/providers/download-context';
import { API_URL, api, requestShareFolderDownloadToken, parseBandwidthError, getApiErrorMessage } from '@/lib/api';
import { LOAD_MORE_ROOT_MARGIN, TOAST_SHORT_MS, DOWNLOAD_CLEANUP_DELAY_MS } from '@/lib/constants';
import type { SharedFolderRoot, FolderRecord, FileRecord, BreadcrumbItem } from '@/lib/types';

export type SortField = 'name' | 'createdAt';
export type SortDirection = 'asc' | 'desc';

/**
 * Data + actions for a public shared-folder view: paginated fetch via share
 * token, breadcrumbs, sort, selection, single + batch (ZIP) download, and the
 * preview-file + context-menu UI state.
 */
export function useSharedFolder(token: string) {
  const { t } = useI18n();
  const selection = useSelection();
  const { startSharedDownload } = useDownload();

  const [rootFolder, setRootFolder] = useState<SharedFolderRoot | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>(undefined);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const foldersCursor = useRef<string | null>(null);
  const filesCursor = useRef<string | null>(null);
  const [hasMoreFolders, setHasMoreFolders] = useState(true);
  const [hasMoreFiles, setHasMoreFiles] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(new Set());
  const [previewFile, setPreviewFile] = useState<FileRecord | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean; x: number; y: number;
    item: FileRecord | FolderRecord | null; type: 'file' | 'folder';
  }>({ isOpen: false, x: 0, y: 0, item: null, type: 'file' });

  const handleSort = useCallback((field: SortField) => {
    setSortDirection(prev => sortField === field ? (prev === 'asc' ? 'desc' : 'asc') : 'asc');
    setSortField(field);
  }, [sortField]);

  const orderedIds = useMemo(
    () => [...folders.map(f => f.id), ...files.map(f => f.id)],
    [folders, files],
  );

  useEffect(() => {
    const handler = () => setContextMenu(prev => ({ ...prev, isOpen: false }));
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  useEffect(() => { selection.clearSelection(); }, [currentFolderId, selection]);

  const fetchContent = useCallback(async (isInitial = true) => {
    if (!token) return;
    if (isInitial) setIsLoading(true); else setIsLoadingMore(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (currentFolderId) params.set('folderId', currentFolderId);
      if (!isInitial) {
        const cursor = foldersCursor.current || filesCursor.current;
        if (cursor) params.set('cursor', cursor);
      }
      params.set('sortField', sortField);
      params.set('sortDirection', sortDirection);

      const query = params.toString();
      const res = await api.get(query ? `/folders/share/${token}?${query}` : `/folders/share/${token}`);

      setRootFolder(res.data.rootFolder);
      if (isInitial) {
        setFolders(res.data.folders || []);
        setFiles(res.data.files || []);
      } else {
        setFolders(prev => {
          const ids = new Set(prev.map((f: FolderRecord) => f.id));
          return [...prev, ...(res.data.folders || []).filter((f: FolderRecord) => !ids.has(f.id))];
        });
        setFiles(prev => {
          const ids = new Set(prev.map((f: FileRecord) => f.id));
          return [...prev, ...(res.data.files || []).filter((f: FileRecord) => !ids.has(f.id))];
        });
      }
      foldersCursor.current = res.data.nextFolderCursor || null;
      filesCursor.current = res.data.nextFileCursor || null;
      setHasMoreFolders(res.data.nextFolderCursor != null);
      setHasMoreFiles(res.data.nextFileCursor != null);
      setBreadcrumbs(res.data.breadcrumbs || []);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, t('shareFolder.folderNotFound')));
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, [token, currentFolderId, t, sortField, sortDirection]);

  const fetchContentRef = useRef(fetchContent);
  fetchContentRef.current = fetchContent;

  useEffect(() => {
    foldersCursor.current = null;
    filesCursor.current = null;
    setHasMoreFolders(true);
    setHasMoreFiles(true);
  }, [currentFolderId, token, sortField, sortDirection]);

  useEffect(() => { fetchContent(true); }, [fetchContent]);

  useEffect(() => {
    if (!loadMoreRef.current) return;
    if (observerRef.current) observerRef.current.disconnect();
    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && (hasMoreFolders || hasMoreFiles) && !isLoading && !isLoadingMore) {
          fetchContentRef.current(false);
        }
      },
      { rootMargin: LOAD_MORE_ROOT_MARGIN },
    );
    observerRef.current.observe(loadMoreRef.current);
    return () => { if (observerRef.current) observerRef.current.disconnect(); };
  }, [hasMoreFolders, hasMoreFiles, isLoading, isLoadingMore]);

  const handleDownload = useCallback(async (fileId: string, filename: string) => {
    setDownloadingFiles(prev => new Set(prev).add(fileId));
    try {
      const { url } = await requestShareFolderDownloadToken(token, fileId);
      toast(t('dashboard.downloadStarted'), { icon: '⬇️', duration: TOAST_SHORT_MS });
      const link = document.createElement('a');
      link.href = API_URL + url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err: unknown) {
      const bw = parseBandwidthError(err);
      if (bw) {
        toast.error(bw.resetTime
          ? t('shareFolder.bandwidthExceededAt', { time: bw.resetTime })
          : t('shareFolder.bandwidthExceeded'));
      } else {
        toast.error(t('shareFolder.downloadError'));
      }
    } finally {
      setTimeout(() => setDownloadingFiles(prev => {
        const n = new Set(prev); n.delete(fileId); return n;
      }), DOWNLOAD_CLEANUP_DELAY_MS);
    }
  }, [token, t]);

  const handleBatchDownload = useCallback(async () => {
    const ids = Array.from(selection.selectedIds);
    const selectedFileIds = ids.filter(id => files.some(f => f.id === id));
    const selectedFolderIds = ids.filter(id => folders.some(f => f.id === id));

    if (ids.length === 0) {
      try {
        await startSharedDownload(token, undefined, undefined, rootFolder?.name || 'shared-folder');
        toast.success(t('downloadZip.preparing'));
      } catch { toast.error(t('downloadZip.failed')); }
      return;
    }

    if (selectedFileIds.length === 1 && selectedFolderIds.length === 0) {
      const file = files.find(f => f.id === selectedFileIds[0])!;
      return handleDownload(file.id, file.filename);
    }

    const label = selectedFolderIds.length === 1 && selectedFileIds.length === 0
      ? folders.find(f => f.id === selectedFolderIds[0])?.name || 'download'
      : `${ids.length} items`;

    try {
      await startSharedDownload(
        token,
        selectedFileIds.length > 0 ? selectedFileIds : undefined,
        selectedFolderIds.length > 0 ? selectedFolderIds : undefined,
        label,
      );
      selection.clearSelection();
      toast.success(t('downloadZip.preparing'));
    } catch { toast.error(t('downloadZip.failed')); }
  }, [selection, files, folders, startSharedDownload, token, rootFolder, handleDownload, t]);

  const openContextMenu = useCallback((e: React.MouseEvent, item: FileRecord | FolderRecord, type: 'file' | 'folder') => {
    e.preventDefault(); e.stopPropagation();
    if (!selection.isSelected(item.id)) {
      selection.clearSelection();
      selection.handleSelect(item.id, { ...e, ctrlKey: false, metaKey: false, shiftKey: false, stopPropagation: () => { } } as React.MouseEvent, orderedIds);
    }
    setTimeout(() => setContextMenu({ isOpen: true, x: e.clientX, y: e.clientY, item, type }), 0);
  }, [selection, orderedIds]);

  const handleItemClick = useCallback((e: React.MouseEvent, item: FileRecord | FolderRecord, type: 'file' | 'folder') => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      selection.handleSelect(item.id, e, orderedIds);
    } else if (type === 'folder') {
      setCurrentFolderId(item.id);
    } else {
      setPreviewFile(item as FileRecord);
    }
  }, [selection, orderedIds]);

  return {
    rootFolder, folders, files, breadcrumbs, error, isLoading,
    hasMore: hasMoreFolders || hasMoreFiles, loadMoreRef,
    downloadingFiles, previewFile, setPreviewFile,
    viewMode, setViewMode, sortField, sortDirection, handleSort,
    selection, contextMenu, setCurrentFolderId,
    handleDownload, handleBatchDownload, openContextMenu, handleItemClick,
  };
}
