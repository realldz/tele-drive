'use client';

import { useState } from 'react';
import { ArrowLeft, FileSearch, Loader2, Search } from 'lucide-react';
import { formatBytes } from '@/lib/api';
import FileDetailsDialog from '@/components/organisms/dialogs/file-details-dialog';
import AdminUserFileRow, { type DownloadPolicyForm } from './admin-user-file-row';
import type { AdminUserBasic, AdminUserFile, FileRecord } from '@/lib/types';

interface AdminUserFilesListProps {
  user: AdminUserBasic;
  files: AdminUserFile[];
  locale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  fileSearch: string;
  onFileSearch: (value: string) => void;
  onLoadMore: () => void;
  onBack: () => void;
  onDeleteFile: (fileId: string) => void;
  onSavePolicy: (fileId: string, form: DownloadPolicyForm) => Promise<void>;
  actionLoading: Set<string>;
}

export default function AdminUserFilesList({
  user, files, locale, t, loading, loadingMore, hasMore,
  fileSearch, onFileSearch, onLoadMore, onBack, onDeleteFile, onSavePolicy, actionLoading,
}: AdminUserFilesListProps) {
  const [detailFile, setDetailFile] = useState<AdminUserFile | null>(null);

  const detailFileAsRecord: FileRecord | null = detailFile
    ? {
        id: detailFile.id,
        filename: detailFile.filename,
        size: Number(detailFile.size),
        mimeType: detailFile.mimeType,
        status: 'complete',
        totalChunks: 0,
        folderId: null,
        userId: user.id,
        visibility: 'PRIVATE',
        shareToken: null,
        createdAt: detailFile.createdAt,
        updatedAt: detailFile.updatedAt,
      }
    : null;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="p-2 bg-gray-200 hover:bg-gray-300 rounded-full transition-colors">
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('admin.userFiles', { username: user.username })}</h1>
            <p className="text-sm text-gray-500 mt-1">{t('admin.userFilesInfo')}</p>
          </div>
        </div>

        <div className="text-sm text-gray-500 space-y-1">
          <div>{t('admin.usedQuota')}: {formatBytes(user.usedSpace)} / {formatBytes(user.quota)}</div>
          <div>{t('admin.role')}: <span className="font-medium text-gray-700">{user.role}</span></div>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
        <input
          type="text"
          placeholder={t('admin.searchFiles')}
          value={fileSearch}
          onChange={(e) => onFileSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-lg outline-none focus:ring focus:ring-blue-100 text-sm"
        />
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[1100px]">
          <thead>
            <tr className="bg-gray-50 text-gray-600 text-sm">
              <th className="p-4 font-medium border-b">{t('admin.fileName')}</th>
              <th className="p-4 font-medium border-b">{t('admin.fileSize')}</th>
              <th className="p-4 font-medium border-b">{t('admin.downloads24h')}</th>
              <th className="p-4 font-medium border-b">{t('admin.bandwidthToday')}</th>
              <th className="p-4 font-medium border-b">{t('admin.lastDownloadReset')}</th>
              <th className="p-4 font-medium border-b text-right">{t('admin.options')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {files.map((file) => (
              <AdminUserFileRow
                key={file.id}
                file={file}
                locale={locale}
                t={t}
                actionLoading={actionLoading}
                onShowDetail={setDetailFile}
                onDeleteFile={onDeleteFile}
                onSavePolicy={onSavePolicy}
              />
            ))}

            {loading && (
              <tr><td colSpan={6} className="p-8 text-center"><Loader2 className="animate-spin text-blue-500 mx-auto" size={24} /></td></tr>
            )}

            {!loading && files.length === 0 && (
              <tr><td colSpan={6} className="p-8 text-center text-gray-500 italic">{t('admin.noFiles')}</td></tr>
            )}
          </tbody>
        </table>

        {loadingMore && (
          <div className="py-3 text-center"><Loader2 className="animate-spin text-blue-500 mx-auto" size={16} /></div>
        )}

        {hasMore && !loadingMore && files.length > 0 && (
          <div className="py-3 text-center">
            <button
              onClick={onLoadMore}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-600 transition-colors flex items-center gap-2 mx-auto"
            >
              <FileSearch size={16} /> {t('dashboard.loadMore')}
            </button>
          </div>
        )}
      </div>

      <FileDetailsDialog
        isOpen={!!detailFile}
        onClose={() => setDetailFile(null)}
        item={detailFileAsRecord}
        itemType="file"
      />
    </div>
  );
}
