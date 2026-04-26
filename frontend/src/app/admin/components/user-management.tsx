'use client';

import { AlertCircle, FileSearch, Loader2, RefreshCw, Search } from 'lucide-react';
import { LOCALE_DATE_MAP } from '@/components/i18n-context';
import { formatBytes } from '@/lib/api';
import type { AdminUser } from '@/lib/types';

interface UserManagementProps {
  users: AdminUser[];
  currentUserId: string | undefined;
  locale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  usersHasMore: boolean;
  onLoadMoreUsers: () => void;
  userSearch: string;
  onUserSearch: (v: string) => void;
  onSelectUser: (user: AdminUser) => void;
  onEditUser: (user: AdminUser) => void;
  onResetPassword: (user: AdminUser) => void;
  onDeleteUser: (id: string, username: string) => void;
  onRetry: () => void;
}

export default function UserManagement({
  users,
  currentUserId,
  locale,
  t,
  loading,
  loadingMore,
  error,
  usersHasMore,
  onLoadMoreUsers,
  userSearch,
  onUserSearch,
  onSelectUser,
  onEditUser,
  onResetPassword,
  onDeleteUser,
  onRetry,
}: UserManagementProps) {
  if (error) {
    return (
      <div className="max-w-6xl mx-auto">
        <h2 className="text-2xl font-bold mb-6 text-gray-800">{t('admin.userList')}</h2>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center">
          <AlertCircle className="text-red-500 mx-auto mb-3" size={48} />
          <p className="text-gray-600 mb-4">{error}</p>
          <button
            onClick={onRetry}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            <RefreshCw size={16} className="inline mr-2" /> {t('dashboard.download')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="relative mb-4 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
        <input
          type="text"
          placeholder={t('admin.searchUsers')}
          value={userSearch}
          onChange={(e) => onUserSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-lg outline-none focus:ring focus:ring-blue-100 text-sm"
        />
      </div>

      <h2 className="text-2xl font-bold mb-4 text-gray-800">{t('admin.userList')}</h2>
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
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-gray-50">
                <td className="p-4 font-medium text-gray-800">{u.username}</td>
                <td className="p-4 text-sm">
                  <span
                    className={`px-2 py-1 rounded-full text-xs font-semibold ${u.role === 'ADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700'}`}
                  >
                    {u.role}
                  </span>
                </td>
                <td className="p-4 text-sm">
                  <div className="w-full bg-gray-200 rounded-full h-1.5 mb-1">
                    <div
                      className="bg-blue-500 h-1.5 rounded-full"
                      style={{
                        width: `${Math.min(100, (Number(u.usedSpace) / Number(u.quota)) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="text-gray-500 text-xs">
                    {formatBytes(u.usedSpace)} / {formatBytes(u.quota)}
                  </span>
                </td>
                <td className="p-4 text-sm text-gray-600">
                  {formatBytes(u.dailyBandwidthUsed)} /{' '}
                  {u.dailyBandwidthLimit === null
                    ? t('admin.noLimit')
                    : formatBytes(u.dailyBandwidthLimit)}
                </td>
                <td className="p-4 text-sm text-gray-500">
                  {new Date(u.createdAt).toLocaleDateString(
                    LOCALE_DATE_MAP[locale as keyof typeof LOCALE_DATE_MAP] || 'en-US',
                  )}
                </td>
                <td className="p-4 text-right space-x-2 whitespace-nowrap">
                  <button
                    onClick={() => onSelectUser(u)}
                    className="px-3 py-1.5 bg-gray-100 text-gray-700 hover:bg-gray-200 rounded-md text-sm font-medium transition-colors"
                  >
                    {t('admin.viewFiles')}
                  </button>
                  <button
                    onClick={() => onEditUser(u)}
                    className="px-3 py-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-md text-sm font-medium transition-colors"
                  >
                    {t('admin.edit')}
                  </button>
                  <button
                    onClick={() => onResetPassword(u)}
                    className="px-3 py-1.5 bg-orange-50 text-orange-600 hover:bg-orange-100 rounded-md text-sm font-medium transition-colors"
                  >
                    {t('admin.resetPassword')}
                  </button>
                  <button
                    onClick={() => onDeleteUser(u.id, u.username)}
                    disabled={currentUserId === u.id}
                    className="px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    {t('admin.delete')}
                  </button>
                </td>
              </tr>
            ))}
            {loading && (
              <tr>
                <td colSpan={6} className="p-8 text-center">
                  <Loader2 className="animate-spin text-blue-500 mx-auto" size={24} />
                </td>
              </tr>
            )}
            {!loading && users.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-gray-500">
                  {t('admin.loadingUsers')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {loadingMore && (
          <div className="py-3 text-center">
            <Loader2 className="animate-spin text-blue-500 mx-auto" size={16} />
          </div>
        )}
        {usersHasMore && !loadingMore && users.length > 0 && (
          <div className="py-3 text-center">
            <button
              onClick={onLoadMoreUsers}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-600 transition-colors flex items-center gap-2 mx-auto"
            >
              <FileSearch size={16} /> {t('dashboard.loadMore')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
