'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/components/i18n-context';
import { useRequireAuth } from '@/hooks/use-require-auth';
import { Menu, Loader2 } from 'lucide-react';
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
  const { isReady, user, logout } = useRequireAuth({ requiredRole: 'ADMIN' });
  const { t, locale } = useI18n();
  const [activeTab, setActiveTab] = useState<Tab>('USERS');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [settings, setSettings] = useState<AdminSetting[]>([]);
  const [editingSettings, setEditingSettings] = useState<Record<string, string>>({});
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [userFiles, setUserFiles] = useState<AdminUserFile[]>([]);

  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);

  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editForm, setEditForm] = useState<{ quotaGB: number | string; bandwidthLimitGB: number | string; role: string }>({ quotaGB: 15, bandwidthLimitGB: 0, role: 'USER' });
  const [resetPwUser, setResetPwUser] = useState<AdminUser | null>(null);
  const [resetPwForm, setResetPwForm] = useState({ newPassword: '', confirmPassword: '' });
  const [resetPwLoading, setResetPwLoading] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<{ type: 'user' | 'file'; id: string; username?: string } | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  const ONE_GB = 1024 ** 3;

  const fetchUsers = async () => {
    setUsersLoading(true);
    setUsersError(null);
    try { setUsers(await fetchUsersApi()); }
    catch (err: unknown) { setUsersError(getApiErrorMessage(err, t('admin.fetchUsersError'))); toast.error(t('admin.fetchUsersError')); }
    finally { setUsersLoading(false); }
  };

  const fetchSettings = async () => {
    try {
      const data = await fetchSettingsApi();
      setSettings(data);
      const initial: Record<string, string> = {};
      data.forEach((s: AdminSetting) => { initial[s.key] = s.value; });
      setEditingSettings(initial);
    } catch (err: unknown) { toast.error(getApiErrorMessage(err, t('admin.fetchSettingsError'))); }
  };

  const fetchUserFiles = async (userId: string) => {
    setFilesLoading(true);
    try { setUserFiles(await fetchUserFilesApi(userId)); }
    catch { toast.error(t('admin.fetchUserFilesError')); }
    finally { setFilesLoading(false); }
  };

  useEffect(() => {
    if (!isReady) return;
    if (activeTab === 'USERS') fetchUsers();
    if (activeTab === 'SETTINGS') fetchSettings();
  }, [isReady, activeTab]);

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
      fetchUsers();
    } catch (err: unknown) { toast.error(getApiErrorMessage(err, t('admin.updateUserError'))); }
  };

  const handleDeleteUser = async (id: string, username: string) => {
    setConfirmDelete({ type: 'user', id, username });
  };

  const handleDeleteUserFile = async (fileId: string) => {
    if (!selectedUser) return;
    setConfirmDelete({ type: 'file', id: fileId });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setConfirmLoading(true);
    try {
      if (confirmDelete.type === 'user') {
        await deleteUserApi(confirmDelete.id);
        toast.success(t('admin.deleteUserSuccess'));
        fetchUsers();
      } else if (confirmDelete.type === 'file' && selectedUser) {
        await deleteUserFileApi(selectedUser.id, confirmDelete.id);
        toast.success(t('admin.deleteFileSuccess'));
        fetchUserFiles(selectedUser.id);
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
        onLogout={() => { logout(); router.push('/login'); }}
        onBackHome={() => router.push('/')}
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
              loading={usersLoading} error={usersError} filesLoading={filesLoading}
              onSelectUser={(u) => { setSelectedUser(u); setActiveTab('USER_FILES'); fetchUserFiles(u.id); }}
              onBack={() => { setActiveTab('USERS'); setSelectedUser(null); }}
              onEditUser={(u) => { setEditingUser(u); setEditForm({ quotaGB: Number(u.quota) / ONE_GB, bandwidthLimitGB: u.dailyBandwidthLimit ? Number(u.dailyBandwidthLimit) / ONE_GB : 0, role: u.role }); }}
              onResetPassword={(u) => { setResetPwUser(u); setResetPwForm({ newPassword: '', confirmPassword: '' }); }}
              onDeleteUser={handleDeleteUser} userFiles={userFiles} onDeleteUserFile={handleDeleteUserFile}
              onRetry={fetchUsers}
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