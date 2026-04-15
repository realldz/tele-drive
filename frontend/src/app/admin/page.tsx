'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/components/i18n-context';
import { useRequireAuth } from '@/hooks/use-require-auth';
import { useNavigation } from '@/components/navigation-loader';
import { Menu, Loader2, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import dynamic from 'next/dynamic';
import type { AdminUser, AdminSetting, AdminUserFile } from '@/lib/types';
import {
  fetchUsers as fetchUsersApi, fetchSettings as fetchSettingsApi,
  updateSetting, updateUserRole, updateUserQuota, updateUserBandwidth,
  deleteUser as deleteUserApi, fetchUserFiles as fetchUserFilesApi,
  deleteUserFile as deleteUserFileApi, adminResetPassword, getApiErrorMessage, formatBytes,
} from '@/lib/api';
import AdminSidebar from './components/admin-sidebar';
import EditUserModal from './components/edit-user-modal';
import ResetPasswordModal from './components/reset-password-modal';
import ConfirmModal from './components/confirm-modal';

const UserManagement = dynamic(() => import('./components/user-management'), { loading: () => <Loader2 className="animate-spin text-blue-500 mx-auto mt-8" size={24} /> });
const SystemSettings = dynamic(() => import('./components/system-settings'), { loading: () => <Loader2 className="animate-spin text-blue-500 mx-auto mt-8" size={24} /> });

type Tab = 'USERS' | 'SETTINGS' | 'USER_FILES';

export default function AdminDashboard() {
  const router = useRouter();
  const { isNavigating } = useNavigation();
  const { isReady, user, logout } = useRequireAuth({ requiredRole: 'ADMIN' });
  const { t, locale } = useI18n();
  const [activeTab, setActiveTab] = useState<Tab>('USERS');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Users list — paginated
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersCursor, setUsersCursor] = useState<string | null>(null);
  const [usersHasMore, setUsersHasMore] = useState(true);
  const [userSearch, setUserSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // User files — paginated
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [userFiles, setUserFiles] = useState<AdminUserFile[]>([]);
  const [userFilesCursor, setUserFilesCursor] = useState<string | null>(null);
  const [userFilesHasMore, setUserFilesHasMore] = useState(true);
  const [fileSearch, setFileSearch] = useState('');
  const fileDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [settings, setSettings] = useState<AdminSetting[]>([]);
  const [editingSettings, setEditingSettings] = useState<Record<string, string>>({});

  const [usersLoading, setUsersLoading] = useState(false);
  const [usersLoadingMore, setUsersLoadingMore] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesLoadingMore, setFilesLoadingMore] = useState(false);

  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editForm, setEditForm] = useState<{ quotaGB: number | string; bandwidthLimitGB: number | string; role: string }>({ quotaGB: 15, bandwidthLimitGB: 0, role: 'USER' });
  const [resetPwUser, setResetPwUser] = useState<AdminUser | null>(null);
  const [resetPwForm, setResetPwForm] = useState({ newPassword: '', confirmPassword: '' });
  const [resetPwLoading, setResetPwLoading] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<{ type: 'user' | 'file'; id: string; username?: string } | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<Set<string>>(new Set());

  const ONE_GB = 1024 ** 3;

  // Users — fetch first page
  const fetchUsers = useCallback(async (search?: string) => {
    setUsersLoading(true);
    setUsersError(null);
    setUsersCursor(null);
    setUsersHasMore(true);
    try {
      const res = await fetchUsersApi(undefined, search);
      setUsers(res.data);
      setUsersCursor(res.nextCursor);
      setUsersHasMore(res.nextCursor !== null);
    } catch (err: unknown) {
      setUsersError(getApiErrorMessage(err, t('admin.fetchUsersError')));
      toast.error(t('admin.fetchUsersError'));
    } finally { setUsersLoading(false); }
  }, [t]);

  // Users — load more
  const loadMoreUsers = useCallback(async () => {
    if (!usersCursor || usersLoadingMore || !usersHasMore) return;
    setUsersLoadingMore(true);
    try {
      const res = await fetchUsersApi(usersCursor, userSearch || undefined);
      setUsers(prev => [...prev, ...res.data]);
      setUsersCursor(res.nextCursor);
      setUsersHasMore(res.nextCursor !== null);
    } catch {
      toast.error(t('admin.fetchUsersError'));
    } finally { setUsersLoadingMore(false); }
  }, [usersCursor, usersLoadingMore, usersHasMore, userSearch, t]);

  // User files — fetch first page
  const fetchUserFiles = useCallback(async (userId: string, search?: string) => {
    setFilesLoading(true);
    setUserFilesCursor(null);
    setUserFilesHasMore(true);
    try {
      const res = await fetchUserFilesApi(userId, undefined, search);
      setUserFiles(res.data);
      setUserFilesCursor(res.nextCursor);
      setUserFilesHasMore(res.nextCursor !== null);
    } catch {
      toast.error(t('admin.fetchUserFilesError'));
    } finally { setFilesLoading(false); }
  }, [t]);

  // User files — load more
  const loadMoreUserFiles = useCallback(async () => {
    if (!userFilesCursor || filesLoadingMore || !userFilesHasMore || !selectedUser) return;
    setFilesLoadingMore(true);
    try {
      const res = await fetchUserFilesApi(selectedUser.id, userFilesCursor, fileSearch || undefined);
      setUserFiles(prev => [...prev, ...res.data]);
      setUserFilesCursor(res.nextCursor);
      setUserFilesHasMore(res.nextCursor !== null);
    } catch {
      toast.error(t('admin.fetchUserFilesError'));
    } finally { setFilesLoadingMore(false); }
  }, [userFilesCursor, filesLoadingMore, userFilesHasMore, selectedUser, fileSearch, t]);

  // Debounced user search
  const handleUserSearch = useCallback((value: string) => {
    setUserSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchUsers(value.trim() || undefined);
    }, 400);
  }, [fetchUsers]);

  // Debounced file search
  const handleFileSearch = useCallback((value: string) => {
    setFileSearch(value);
    if (fileDebounceRef.current) clearTimeout(fileDebounceRef.current);
    fileDebounceRef.current = setTimeout(() => {
      if (selectedUser) {
        fetchUserFiles(selectedUser.id, value.trim() || undefined);
      }
    }, 400);
  }, [fetchUserFiles, selectedUser]);

  useEffect(() => {
    if (!isReady) return;
    if (activeTab === 'USERS') fetchUsers();
    if (activeTab === 'SETTINGS') fetchSettings();
    if (activeTab === 'USER_FILES' && selectedUser) {
      // Don't re-fetch when switching back, keep existing files
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, activeTab]);

  const fetchSettings = async () => {
    try {
      const data = await fetchSettingsApi();
      setSettings(data);
      const initial: Record<string, string> = {};
      data.forEach((s: AdminSetting) => { initial[s.key] = s.value; });
      setEditingSettings(initial);
    } catch (err: unknown) { toast.error(getApiErrorMessage(err, t('admin.fetchSettingsError'))); }
  };

  const handleUpdateSetting = async (key: string, value: string) => {
    try { await updateSetting(key, value); toast.success(t('admin.updateSettingSuccess')); fetchSettings(); }
    catch { toast.error(t('admin.updateSettingError')); }
  };

  const handleEditUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    try {
      await updateUserRole(editingUser.id, editForm.role);
      const quotaBytes = Math.round(Number(editForm.quotaGB) * ONE_GB).toString();
      const bwGb = Number(editForm.bandwidthLimitGB);
      const bwBytes = bwGb > 0 ? Math.round(bwGb * ONE_GB).toString() : null;
      await updateUserQuota(editingUser.id, quotaBytes);
      await updateUserBandwidth(editingUser.id, bwBytes);
      toast.success(t('admin.updateUserSuccess'));
      setEditingUser(null);
      fetchUsers(userSearch || undefined);
    } catch (err: unknown) { toast.error(getApiErrorMessage(err, t('admin.updateUserError'))); }
  };

  const handleDeleteUser = async (id: string, username: string) => {
    setConfirmDelete({ type: 'user', id, username });
  };

  const handleDeleteUserFile = async (fileId: string) => {
    if (!selectedUser) return;
    setActionLoading(prev => new Set(prev).add(fileId));
    try {
      await deleteUserFileApi(selectedUser.id, fileId);
      setUserFiles(prev => prev.filter(f => f.id !== fileId));
    } catch {
      toast.error(t('admin.deleteFileError'));
    } finally {
      setActionLoading(prev => { const next = new Set(prev); next.delete(fileId); return next; });
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setConfirmLoading(true);
    try {
      if (confirmDelete.type === 'user') {
        await deleteUserApi(confirmDelete.id);
        toast.success(t('admin.deleteUserSuccess'));
        fetchUsers(userSearch || undefined);
      } else if (confirmDelete.type === 'file' && selectedUser) {
        await deleteUserFileApi(selectedUser.id, confirmDelete.id);
        toast.success(t('admin.deleteFileSuccess'));
        setUserFiles(prev => prev.filter(f => f.id !== confirmDelete.id));
      }
    } catch (err: unknown) {
      const fallback = confirmDelete.type === 'user' ? t('admin.deleteUserError') : t('admin.deleteFileError');
      toast.error(getApiErrorMessage(err, fallback));
    } finally {
      setConfirmLoading(false);
      setConfirmDelete(null);
    }
  };

  const handleAdminResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPwUser) return;
    if (resetPwForm.newPassword !== resetPwForm.confirmPassword) { toast.error(t('password.mismatch')); return; }
    if (resetPwForm.newPassword.length < 4) { toast.error(t('password.tooShort')); return; }
    setResetPwLoading(true);
    try {
      await adminResetPassword(resetPwUser.id, resetPwForm.newPassword);
      toast.success(t('admin.resetPasswordSuccess'));
      setResetPwUser(null); setResetPwForm({ newPassword: '', confirmPassword: '' });
    } catch (err: unknown) { toast.error(getApiErrorMessage(err, t('admin.resetPasswordError'))); }
    finally { setResetPwLoading(false); }
  };

  if (!isReady) return null;

  return (
    <div className="h-screen bg-gray-50 flex overflow-hidden">
      <AdminSidebar
        activeTab={activeTab}
        setActiveTab={(tab) => { setActiveTab(tab); setSelectedUser(null); setIsMobileSidebarOpen(false); }}
        user={user}
        onLogout={() => { if (!isNavigating) { logout(); router.push('/login'); } }}
        onBackHome={() => { if (!isNavigating) { router.push('/'); } }}
        isMobileOpen={isMobileSidebarOpen}
        setIsMobileOpen={setIsMobileSidebarOpen}
      />

      <main className="flex-1 flex flex-col min-w-0 bg-gray-50 relative">
        <header className="md:hidden h-16 border-b border-gray-200 flex items-center px-4 bg-white flex-shrink-0 z-10 w-full">
          <button className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-lg" onClick={() => setIsMobileSidebarOpen(true)}><Menu size={24} /></button>
          <h2 className="text-lg font-bold ml-2 text-gray-800">{t('admin.panel')}</h2>
        </header>

        <div className="flex-1 overflow-auto p-4 md:p-6 lg:p-8">
          {activeTab === 'SETTINGS' && (
            <SystemSettings settings={settings} editingSettings={editingSettings} t={t} formatBytes={formatBytes}
              onSettingChange={(key, value) => setEditingSettings({ ...editingSettings, [key]: value })}
              onUpdateSetting={handleUpdateSetting} />
          )}

          {(activeTab === 'USERS' || activeTab === 'USER_FILES') && (
            <UserManagement
              users={users} selectedUser={selectedUser} currentUserId={user?.id} locale={locale} t={t}
              loading={usersLoading} loadingMore={usersLoadingMore} error={usersError} filesLoading={filesLoading} filesLoadingMore={filesLoadingMore}
              usersHasMore={usersHasMore} filesHasMore={userFilesHasMore}
              onLoadMoreUsers={loadMoreUsers} onLoadMoreUserFiles={loadMoreUserFiles}
              userSearch={userSearch} onUserSearch={handleUserSearch}
              fileSearch={fileSearch} onFileSearch={handleFileSearch}
              userFiles={userFiles}
              onSelectUser={(u) => { setSelectedUser(u); setActiveTab('USER_FILES'); fetchUserFiles(u.id); }}
              onResetSelectedUser={() => { setActiveTab('USERS'); setSelectedUser(null); setUserFiles([]); setUserFilesCursor(null); setUserFilesHasMore(true); setFileSearch(''); }}
              onEditUser={(u) => { setEditingUser(u); setEditForm({ quotaGB: Number(u.quota) / ONE_GB, bandwidthLimitGB: u.dailyBandwidthLimit ? Number(u.dailyBandwidthLimit) / ONE_GB : 0, role: u.role }); }}
              onResetPassword={(u) => { setResetPwUser(u); setResetPwForm({ newPassword: '', confirmPassword: '' }); }}
              onDeleteUser={handleDeleteUser}
              onDeleteUserFile={handleDeleteUserFile}
              onRetry={() => fetchUsers(userSearch || undefined)}
              actionLoading={actionLoading}
            />
          )}
        </div>
      </main>

      {editingUser && (
        <EditUserModal
          user={editingUser} currentUserId={user?.id} form={editForm} onFormChange={setEditForm}
          t={t} onSubmit={handleEditUserSubmit} onClose={() => setEditingUser(null)}
        />
      )}

      {resetPwUser && (
        <ResetPasswordModal
          username={resetPwUser.username} form={resetPwForm} onFormChange={setResetPwForm}
          loading={resetPwLoading} t={t} onSubmit={handleAdminResetPassword}
          onClose={() => { setResetPwUser(null); setResetPwForm({ newPassword: '', confirmPassword: '' }); }}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title={confirmDelete.type === 'user' ? t('admin.delete') : t('admin.deletePermanent')}
          message={confirmDelete.type === 'user'
            ? t('admin.confirmDeleteUser', { username: confirmDelete.username ?? '' })
            : t('admin.confirmDeleteFile')}
          loading={confirmLoading} t={t}
          onConfirm={handleConfirmDelete} onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
