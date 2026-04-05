'use client';

import { useState } from 'react';
import { ArrowLeft, Trash2, Loader2, Search, Info, AlertCircle, RefreshCw } from 'lucide-react';
import { LOCALE_DATE_MAP } from '@/components/i18n-context';
import { formatBytes } from '@/lib/api';
import { getFileIcon } from '@/lib/file-icon';
import { useLazyLoad } from '@/hooks/use-lazy-load';
import FileDetailsDialog from '@/components/file-details-dialog';
import type { FileRecord, AdminUser, AdminUserFile } from '@/lib/types';

interface UserManagementProps {
  users: AdminUser[];
  selectedUser: AdminUser | null;
  currentUserId: string | undefined;
  locale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  loading: boolean;
  error: string | null;
  filesLoading: boolean;
  onSelectUser: (user: AdminUser) => void;
  onBack: () => void;
  onEditUser: (user: AdminUser) => void;
  onResetPassword: (user: AdminUser) => void;
  onDeleteUser: (id: string, username: string) => void;
  userFiles: AdminUserFile[];
  onDeleteUserFile: (fileId: string) => void;
  onRetry: () => void;
}

export default function UserManagement({
  users, selectedUser, currentUserId, locale, t,
  loading, error, filesLoading,
  onSelectUser, onBack, onEditUser, onResetPassword, onDeleteUser,
  userFiles, onDeleteUserFile, onRetry,
}: UserManagementProps) {
  const [fileSearch, setFileSearch] = useState('');
  const [detailFile, setDetailFile] = useState<AdminUserFile | null>(null);

  const filteredFiles = userFiles.filter(f =>
    f.filename.toLowerCase().includes(fileSearch.toLowerCase())
  );

  const { visibleCount: usersVisible, hasMore: usersHasMore, loadMoreRef: usersLoadMoreRef } = useLazyLoad(users.length);
  const { visibleCount: filesVisible, hasMore: filesHasMore, loadMoreRef: filesLoadMoreRef } = useLazyLoad(filteredFiles.length);

  const detailFileAsRecord: FileRecord | null = detailFile ? {
    id: detailFile.id,
    filename: detailFile.filename,
    size: Number(detailFile.size),
    mimeType: detailFile.mimeType,
    status: 'complete',
    totalChunks: 0,
    folderId: null,
    userId: selectedUser?.id ?? '',
    visibility: 'PRIVATE',
    shareToken: null,
    createdAt: detailFile.createdAt,
    updatedAt: detailFile.createdAt,
  } : null;

  if (selectedUser) {
    return (
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <button onClick={onBack} className="p-2 bg-gray-200 hover:bg-gray-300 rounded-full transition-colors">
            <ArrowLeft size={20} />
          </button>
          <div>
            <h2 className="text-2xl font-bold text-gray-800">{t('admin.userFiles', { username: selectedUser.username })}</h2>
            <p className="text-gray-500 text-sm">{t('admin.userFilesInfo')}</p>
          </div>
        </div>

        <div className="relative mb-4 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
          <input type="text" placeholder={t('admin.searchFiles')} value={fileSearch} onChange={(e) => setFileSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-lg outline-none focus:ring focus:ring-blue-100 text-sm" />
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[600px]">
            <thead>
              <tr className="bg-gray-50 text-gray-600 text-sm">
                <th className="p-4 font-medium border-b">{t('admin.fileName')}</th>
                <th className="p-4 font-medium border-b">{t('admin.fileSize')}</th>
                <th className="p-4 font-medium border-b">{t('admin.format')}</th>
                <th className="p-4 font-medium border-b">{t('admin.uploadDate')}</th>
                <th className="p-4 font-medium border-b text-right">{t('admin.options')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredFiles.slice(0, filesVisible).map((file) => (
                <tr key={file.id} className="hover:bg-gray-50">
                  <td className="p-4 font-medium text-gray-800 flex items-center gap-2">
                    {getFileIcon(file.mimeType, 'w-5 h-5')}
                    <span className="truncate max-w-[200px]">{file.filename}</span>
                    {file.isEncrypted && <span className="bg-green-100 text-green-700 text-[10px] px-1.5 py-0.5 rounded uppercase font-bold">{t('admin.encrypted')}</span>}
                  </td>
                  <td className="p-4 text-sm text-gray-600">{formatBytes(file.size)}</td>
                  <td className="p-4 text-sm text-gray-500">{file.mimeType}</td>
                  <td className="p-4 text-sm text-gray-500">{new Date(file.createdAt).toLocaleString(LOCALE_DATE_MAP[locale as keyof typeof LOCALE_DATE_MAP] || 'en-US')}</td>
                  <td className="p-4 text-right whitespace-nowrap">
                    <button onClick={() => setDetailFile(file)} className="p-2 text-blue-500 hover:bg-blue-50 rounded-lg transition-colors inline-block mr-1" title={t('admin.fileDetails')} aria-label={t('admin.fileDetails')}>
                      <Info size={18} />
                    </button>
                    <button onClick={() => onDeleteUserFile(file.id)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors inline-block" title={t('admin.deletePermanent')} aria-label={t('admin.deletePermanent')}>
                      <Trash2 size={18} />
                    </button>
                  </td>
                </tr>
              ))}
              {filesLoading && (
                <tr><td colSpan={5} className="p-8 text-center"><Loader2 className="animate-spin text-blue-500 mx-auto" size={24} /></td></tr>
              )}
              {!filesLoading && filteredFiles.length === 0 && (
                <tr><td colSpan={5} className="p-8 text-center text-gray-500 italic">{t('admin.noFiles')}</td></tr>
              )}
            </tbody>
          </table>
          {filesHasMore && <div ref={filesLoadMoreRef} className="py-3 text-center text-gray-400 text-sm">{t('dashboard.loading')}</div>}
        </div>

        <FileDetailsDialog isOpen={!!detailFile} onClose={() => setDetailFile(null)} item={detailFileAsRecord} itemType="file" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-6xl mx-auto">
        <h2 className="text-2xl font-bold mb-6 text-gray-800">{t('admin.userList')}</h2>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center">
          <AlertCircle className="text-red-500 mx-auto mb-3" size={48} />
          <p className="text-gray-600 mb-4">{error}</p>
          <button onClick={onRetry} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium">
            <RefreshCw size={16} className="inline mr-2" /> {t('dashboard.download')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold mb-6 text-gray-800">{t('admin.userList')}</h2>
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[800px]">
          <thead>
            <tr className="bg-gray-50 text-gray-600 text-sm">
              <th className="p-4 font-medium border-b">{t('admin.account')}</th>
              <th className="p-4 font-medium border-b">{t('admin.role')}</th>
              <th className="p-4 font-medium border-b">{t('admin.usedQuota')}</th>
              <th className="p-4 font-medium border-b">{t('admin.bandwidthToday')}</th>
              <th className="p-4 font-medium border-b">{t('admin.createdDate')}</th>
              <th className="p-4 font-medium border-b text-right">{t('admin.options')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.slice(0, usersVisible).map((u) => (
              <tr key={u.id} className="hover:bg-gray-50">
                <td className="p-4 font-medium text-gray-800">{u.username}</td>
                <td className="p-4 text-sm">
                  <span className={`px-2 py-1 rounded-full text-xs font-semibold ${u.role === 'ADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700'}`}>{u.role}</span>
                </td>
                <td className="p-4 text-sm">
                  <div className="w-full bg-gray-200 rounded-full h-1.5 mb-1">
                    <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${Math.min(100, (Number(u.usedSpace) / Number(u.quota)) * 100)}%` }} />
                  </div>
                  <span className="text-gray-500 text-xs">{formatBytes(u.usedSpace)} / {formatBytes(u.quota)}</span>
                </td>
                <td className="p-4 text-sm text-gray-600">
                  {formatBytes(u.dailyBandwidthUsed)} / {u.dailyBandwidthLimit === null ? t('admin.noLimit') : formatBytes(u.dailyBandwidthLimit)}
                </td>
                <td className="p-4 text-sm text-gray-500">{new Date(u.createdAt).toLocaleDateString(LOCALE_DATE_MAP[locale as keyof typeof LOCALE_DATE_MAP] || 'en-US')}</td>
                <td className="p-4 text-right space-x-2 whitespace-nowrap">
                  <button onClick={() => onSelectUser(u)} className="px-3 py-1.5 bg-gray-100 text-gray-700 hover:bg-gray-200 rounded-md text-sm font-medium transition-colors">{t('admin.viewFiles')}</button>
                  <button onClick={() => onEditUser(u)} className="px-3 py-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-md text-sm font-medium transition-colors">{t('admin.edit')}</button>
                  <button onClick={() => onResetPassword(u)} className="px-3 py-1.5 bg-orange-50 text-orange-600 hover:bg-orange-100 rounded-md text-sm font-medium transition-colors">{t('admin.resetPassword')}</button>
                  <button onClick={() => onDeleteUser(u.id, u.username)} disabled={currentUserId === u.id}
                    className="px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 rounded-md text-sm font-medium transition-colors disabled:opacity-50">{t('admin.delete')}</button>
                </td>
              </tr>
            ))}
            {loading && (
              <tr><td colSpan={6} className="p-8 text-center"><Loader2 className="animate-spin text-blue-500 mx-auto" size={24} /></td></tr>
            )}
            {!loading && users.length === 0 && (
              <tr><td colSpan={6} className="p-8 text-center text-gray-500">{t('admin.loadingUsers')}</td></tr>
            )}
          </tbody>
        </table>
        {usersHasMore && <div ref={usersLoadMoreRef} className="py-3 text-center text-gray-400 text-sm">{t('dashboard.loading')}</div>}
      </div>
    </div>
  );
}