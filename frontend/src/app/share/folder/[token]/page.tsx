'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { AlertCircle, ChevronRight, Home, UserCircle2, LayoutGrid, List } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import { useAuth } from '@/components/auth-context';
import GuestLanguageSwitcher from '@/components/guest-language-switcher';
import toast from 'react-hot-toast';

import { API_URL, api, requestShareFolderDownloadToken, parseBandwidthError, getApiErrorMessage } from '@/lib/api';
import type { SharedFolderRoot, FolderRecord, FileRecord, BreadcrumbItem } from '@/lib/types';
import SharedFolderPreviewModal from './shared-folder-preview-modal';
import FileGrid from '@/components/file-grid';

type SortField = 'name' | 'createdAt';
type SortDirection = 'asc' | 'desc';

export default function SharedFolderPage() {
  const params = useParams();
  const token = params.token as string;
  const { t } = useI18n();
  const { user } = useAuth();

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

  // Grid/list toggle
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  // Sort
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const handleSort = useCallback((field: SortField) => {
    setSortDirection(prev => sortField === field ? (prev === 'asc' ? 'desc' : 'asc') : 'asc');
    setSortField(field);
  }, [sortField]);

  // Filter + sort
  const filteredFolders = useMemo(() => {
    return [...folders].sort((a, b) => {
      const cmp = sortField === 'name'
        ? a.name.localeCompare(b.name)
        : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [folders, sortField, sortDirection]);

  const filteredFiles = useMemo(() => {
    return [...files].sort((a, b) => {
      const cmp = sortField === 'name'
        ? a.filename.localeCompare(b.filename)
        : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [files, sortField, sortDirection]);

  const fetchContent = useCallback(async (isInitial = true) => {
    if (!token) return;
    if (isInitial) {
      setIsLoading(true);
    } else {
      setIsLoadingMore(true);
    }
    setError(null);
    try {
      const params = new URLSearchParams();
      if (currentFolderId) params.set('folderId', currentFolderId);
      if (!isInitial) {
        const cursor = foldersCursor.current || filesCursor.current;
        if (cursor) params.set('cursor', cursor);
      }

      const query = params.toString();
      const url = query
        ? `/folders/share/${token}?${query}`
        : `/folders/share/${token}`;
      const res = await api.get(url);

      setRootFolder(res.data.rootFolder);
      if (isInitial) {
        setFolders(res.data.folders || []);
        setFiles(res.data.files || []);
      } else {
        setFolders(prev => [...prev, ...(res.data.folders || [])]);
        setFiles(prev => [...prev, ...(res.data.files || [])]);
      }
      foldersCursor.current = res.data.nextFolderCursor || null;
      filesCursor.current = res.data.nextFileCursor || null;
      setHasMoreFolders(res.data.nextFolderCursor !== null && res.data.nextFolderCursor !== undefined);
      setHasMoreFiles(res.data.nextFileCursor !== null && res.data.nextFileCursor !== undefined);
      setBreadcrumbs(res.data.breadcrumbs || []);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, t('shareFolder.folderNotFound')));
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, [token, currentFolderId, t]);

  useEffect(() => {
    foldersCursor.current = null;
    filesCursor.current = null;
    setHasMoreFolders(true);
    setHasMoreFiles(true);
  }, [currentFolderId, token]);

  useEffect(() => {
    fetchContent(true);
  }, [fetchContent]);

  // IntersectionObserver for load more
  useEffect(() => {
    if (!loadMoreRef.current) return;
    if (observerRef.current) observerRef.current.disconnect();

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && (hasMoreFolders || hasMoreFiles) && !isLoading && !isLoadingMore) {
          fetchContent(false);
        }
      },
      { rootMargin: '200px' },
    );

    observerRef.current.observe(loadMoreRef.current);
    return () => { if (observerRef.current) observerRef.current.disconnect(); };
  }, [hasMoreFolders, hasMoreFiles, isLoading, isLoadingMore, fetchContent]);

  const handleDownload = useCallback(async (fileId: string, filename: string) => {
    setDownloadingFiles(prev => new Set(prev).add(fileId));
    try {
      const { url } = await requestShareFolderDownloadToken(token, fileId);
      toast(t('dashboard.downloadStarted'), { icon: '⬇️', duration: 2000 });
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
      setTimeout(() => setDownloadingFiles(prev => { const n = new Set(prev); n.delete(fileId); return n; }), 2000);
    }
  }, [token, t]);

  const handleItemClick = useCallback((e: React.MouseEvent, item: FileRecord | FolderRecord, type: 'file' | 'folder') => {
    if (type === 'folder') {
      setCurrentFolderId(item.id);
    } else {
      setPreviewFile(item as FileRecord);
    }
  }, []);

  const hasMore = hasMoreFolders || hasMoreFiles;

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <GuestLanguageSwitcher />
        <div className="flex flex-col items-center bg-white p-8 rounded-2xl shadow-sm">
          <div className="w-16 h-16 bg-red-100 text-red-500 rounded-full flex items-center justify-center mb-4">
            <AlertCircle size={32} />
          </div>
          <h2 className="text-xl font-semibold text-gray-800 mb-2">{t('shareFolder.cannotAccess')}</h2>
          <p className="text-gray-500">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <GuestLanguageSwitcher />
      <div className="max-w-5xl mx-auto bg-white shadow-sm rounded-2xl overflow-hidden border border-gray-100">
        {/* Header */}
        <div className="bg-slate-900 justify-between items-center text-white p-6 flex">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Tele-Drive</h1>
            <p className="text-slate-400 text-sm mt-1">
              {t('shareFolder.sharedBy')}: <span className="text-slate-200">{rootFolder?.user?.username || t('shareFolder.user')}</span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* View toggle */}
            <div className="flex bg-slate-800 p-1 rounded-lg">
              <button
                onClick={() => setViewMode('grid')}
                className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                title={t('dashboard.gridView')}
              >
                <LayoutGrid size={18} />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                title={t('dashboard.listView')}
              >
                <List size={18} />
              </button>
            </div>
            {user && (
              <div className="flex items-center gap-2 text-slate-300 text-sm bg-slate-800 px-3 py-2 rounded-lg">
                <UserCircle2 size={16} />
                <span className="font-medium">{user.username}</span>
              </div>
            )}
          </div>
        </div>

        <div className="p-6">
          {/* Breadcrumbs */}
          <div className="flex items-center text-sm text-gray-600 mb-6 bg-gray-50 px-4 py-3 rounded-xl overflow-x-auto">
            <button
              onClick={() => setCurrentFolderId(undefined)}
              className="hover:text-blue-600 transition-colors flex items-center gap-1 font-medium whitespace-nowrap"
            >
              <Home size={16} /> {t('shareFolder.shareHome')}
            </button>

            {breadcrumbs.map((crumb, index) => (
              <div key={crumb.id} className="flex items-center whitespace-nowrap">
                <ChevronRight size={16} className="mx-1 text-gray-400" />
                <button
                  onClick={() => setCurrentFolderId(crumb.id)}
                  className={`hover:text-blue-600 transition-colors ${index === breadcrumbs.length - 1 ? 'text-gray-900 font-semibold' : 'font-medium'
                    }`}
                >
                  {crumb.name}
                </button>
              </div>
            ))}
          </div>

          {/* Content */}
          <FileGrid
            folders={filteredFolders}
            files={filteredFiles}
            viewMode={viewMode}
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
            downloadingFiles={downloadingFiles}
            hasMore={hasMore}
            loadMoreRef={loadMoreRef}
            isLoadingContent={isLoading}
            emptyMessage={t('shareFolder.emptyFolder')}
            onItemClick={handleItemClick}
            onDownload={handleDownload}
          />
        </div>
      </div>

      <SharedFolderPreviewModal
        shareToken={token}
        file={previewFile}
        onClose={() => setPreviewFile(null)}
      />
    </div>
  );
}
