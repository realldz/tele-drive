'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import { Download, AlertCircle, Folder, ChevronRight, Home, UserCircle2, FileSearch, Loader2 } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import { useAuth } from '@/components/auth-context';
import GuestLanguageSwitcher from '@/components/guest-language-switcher';
import toast from 'react-hot-toast';

import { API_URL, api, formatSize, requestShareFolderDownloadToken, parseBandwidthError, getApiErrorMessage } from '@/lib/api';
import type { SharedFolderRoot, FolderRecord, FileRecord, BreadcrumbItem } from '@/lib/types';
import SharedFolderPreviewModal from './shared-folder-preview-modal';
import { getFileIcon } from '@/lib/file-icon';

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
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<FileRecord | null>(null);

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

  const handleDownload = async (file: FileRecord) => {
    setDownloadingId(file.id);
    try {
      const { url } = await requestShareFolderDownloadToken(token, file.id);
      toast(t('dashboard.downloadStarted'), { icon: '⬇️', duration: 2000 });
      const link = document.createElement('a');
      link.href = API_URL + url;
      link.setAttribute('download', file.filename);
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
      setTimeout(() => setDownloadingId(null), 2000);
    }
  };

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
        <div className="bg-slate-900 justify-between items-center text-white p-6 flex">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Tele-Drive</h1>
            <p className="text-slate-400 text-sm mt-1">
              {t('shareFolder.sharedBy')}: <span className="text-slate-200">{rootFolder?.user?.username || t('shareFolder.user')}</span>
            </p>
          </div>
          {user && (
            <div className="flex items-center gap-2 text-slate-300 text-sm bg-slate-800 px-3 py-2 rounded-lg">
              <UserCircle2 size={16} />
              <span className="font-medium">{user.username}</span>
            </div>
          )}
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

          {isLoading ? (
            <div className="text-center py-12 text-gray-500">{t('shareFolder.loading')}</div>
          ) : folders.length === 0 && files.length === 0 ? (
            <div className="text-center py-16 bg-gray-50 rounded-xl border border-dashed border-gray-200">
              <Folder size={48} className="mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500">{t('shareFolder.emptyFolder')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {/* Folders */}
              {folders.map(folder => (
                <div
                  key={folder.id}
                  onClick={() => setCurrentFolderId(folder.id)}
                  className="bg-white border border-gray-100 p-4 rounded-xl flex items-center hover:shadow-md hover:border-blue-100 transition-all cursor-pointer group"
                >
                  <div className="w-10 h-10 bg-blue-50 text-blue-500 rounded-lg flex items-center justify-center mr-3 group-hover:bg-blue-100 transition-colors">
                    <Folder size={20} className="fill-current opacity-20" />
                  </div>
                  <span className="font-medium text-gray-800 truncate" title={folder.name}>
                    {folder.name}
                  </span>
                </div>
              ))}

              {/* Files */}
              {files.map(file => (
                <div
                  key={file.id}
                  onClick={() => setPreviewFile(file)}
                  className="bg-white border border-gray-100 p-4 rounded-xl flex items-start hover:shadow-md hover:border-blue-100 transition-all cursor-pointer group"
                >
                  <div className="flex-1 overflow-hidden pr-2">
                    <div className="flex items-start mb-2">
                      <div className="w-8 h-8 mr-2 flex-shrink-0 flex items-center justify-center bg-gray-50 rounded-lg border border-gray-100">
                        {getFileIcon(file.mimeType, 'w-5 h-5')}
                      </div>
                      <div className="overflow-hidden">
                        <span className="font-medium text-gray-800 text-sm break-all line-clamp-2" title={file.filename}>
                          {file.filename}
                        </span>
                        <span className="text-xs text-gray-500 mt-1 block">{formatSize(Number(file.size))}</span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDownload(file); }}
                    disabled={downloadingId === file.id}
                    className="p-2 text-blue-600 bg-blue-50 hover:bg-blue-600 hover:text-white rounded-lg transition-colors flex-shrink-0 disabled:opacity-50"
                    title={t('shareFolder.download')}
                  >
                    <Download size={18} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Load More */}
          {(hasMoreFolders || hasMoreFiles) && !isLoading && (
            <div ref={loadMoreRef} className="py-6 text-center">
              {isLoadingMore ? (
                <Loader2 className="animate-spin text-blue-500 mx-auto" size={20} />
              ) : (
                <button onClick={() => fetchContent(false)} className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-600 transition-colors flex items-center gap-2 mx-auto">
                  <FileSearch size={16} /> {t('dashboard.loadMore')}
                </button>
              )}
            </div>
          )}
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
