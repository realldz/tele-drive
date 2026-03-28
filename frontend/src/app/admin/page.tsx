'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n, LOCALE_DATE_MAP } from '@/components/i18n-context';
import { useRequireAuth } from '@/hooks/use-require-auth';
import { Settings, ArrowLeft, ShieldAlert, Menu, X, LogOut, User, Loader2, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import dynamic from 'next/dynamic';
import {
  fetchUsers as fetchUsersApi, fetchSettings as fetchSettingsApi,
  updateSetting, updateUserRole, updateUserQuota, updateUserBandwidth,
  deleteUser as deleteUserApi, fetchUserFiles as fetchUserFilesApi,
  deleteUserFile as deleteUserFileApi, adminResetPassword, getApiErrorMessage,
} from '@/lib/api';

const UserManagement = dynamic(() => import('./components/user-management'), { loading: () => <Loader2 className="animate-spin text-blue-500 mx-auto mt-8" size={24} /> });
const SystemSettings = dynamic(() => import('./components/system-settings'), { loading: () => <Loader2 className="animate-spin text-blue-500 mx-auto mt-8" size={24} /> });

type UserRole = 'ADMIN' | 'USER';
interface UserRecord { id: string; username: string; role: UserRole; quota: string; usedSpace: string; dailyBandwidthLimit: string | null; dailyBandwidthUsed: string; createdAt: string; }
interface Setting { key: string; value: string; }
interface UserFile { id: string; filename: string; size: string; mimeType: string; createdAt: string; isEncrypted: boolean; }
type Tab = 'USERS' | 'SETTINGS' | 'USER_FILES';

export default function AdminDashboard() {
  const router = useRouter();
  const { isReady, user, logout } = useRequireAuth({ requiredRole: 'ADMIN' });
  const { t, locale } = useI18n();
  const [activeTab, setActiveTab] = useState<Tab>('USERS');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  const [users, setUsers] = useState<UserRecord[]>([]);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [editingSettings, setEditingSettings] = useState<Record<string, string>>({});
  const [selectedUser, setSelectedUser] = useState<UserRecord | null>(null);
  const [userFiles, setUserFiles] = useState<UserFile[]>([]);

  // Edit user modal
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
  const [editForm, setEditForm] = useState<{ quotaGB: number | string, bandwidthLimitGB: number | string, role: string }>({ quotaGB: 15, bandwidthLimitGB: 0, role: 'USER' });
  // Reset password modal
  const [resetPwUser, setResetPwUser] = useState<UserRecord | null>(null);
  const [resetPwForm, setResetPwForm] = useState({ newPassword: '', confirmPassword: '' });
  const [resetPwLoading, setResetPwLoading] = useState(false);

  useEffect(() => {
    if (!isReady) return;
    if (activeTab === 'USERS') fetchUsers();
    if (activeTab === 'SETTINGS') fetchSettings();
  }, [isReady, activeTab]);

  const fetchUsers = async () => { try { setUsers(await fetchUsersApi()); } catch { toast.error(t('admin.fetchUsersError')); } };
  const fetchSettings = async () => {
    try {
      const data = await fetchSettingsApi();
      setSettings(data);
      const initial: Record<string, string> = {};
      data.forEach((s: Setting) => { initial[s.key] = s.value; });
      setEditingSettings(initial);
    } catch { toast.error(t('admin.fetchSettingsError')); }
  };
  const fetchUserFiles = async (userId: string) => { try { setUserFiles(await fetchUserFilesApi(userId)); } catch { toast.error(t('admin.fetchUserFilesError')); } };

  const formatBytes = (bytes: string | number) => {
    const size = Number(bytes);
    if (size === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(size) / Math.log(k));
    return parseFloat((size / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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
      
      const quotaBytes = Math.round(Number(editForm.quotaGB) * (1024 ** 3)).toString();
      const bwGb = Number(editForm.bandwidthLimitGB);
      const bwBytes = bwGb > 0 ? Math.round(bwGb * (1024 ** 3)).toString() : null;
      
      await updateUserQuota(editingUser.id, quotaBytes);
      await updateUserBandwidth(editingUser.id, bwBytes);
      toast.success(t('admin.updateUserSuccess'));
      setEditingUser(null);
      fetchUsers();
    } catch (err: unknown) { toast.error(getApiErrorMessage(err, t('admin.updateUserError'))); }
  };

  const handleDeleteUser = async (id: string, username: string) => {
    if (!confirm(t('admin.confirmDeleteUser', { username }))) return;
    try { await deleteUserApi(id); toast.success(t('admin.deleteUserSuccess')); fetchUsers(); }
    catch (err: unknown) { toast.error(getApiErrorMessage(err, t('admin.deleteUserError'))); }
  };

  const handleDeleteUserFile = async (fileId: string) => {
    if (!selectedUser || !confirm(t('admin.confirmDeleteFile'))) return;
    try { await deleteUserFileApi(selectedUser.id, fileId); toast.success(t('admin.deleteFileSuccess')); fetchUserFiles(selectedUser.id); }
    catch { toast.error(t('admin.deleteFileError')); }
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
      {isMobileSidebarOpen && <div className="fixed inset-0 bg-black/50 z-20 md:hidden" onClick={() => setIsMobileSidebarOpen(false)} />}

      {/* Sidebar */}
      <aside className={`fixed md:static inset-y-0 left-0 w-64 bg-slate-900 border-r border-slate-800 flex flex-col transition-transform duration-300 z-30 ${isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="p-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-white">Tele-Drive</h1>
          <button className="md:hidden text-slate-400 hover:text-white" onClick={() => setIsMobileSidebarOpen(false)}><X size={24} /></button>
        </div>
        <div className="px-6 mb-4">
          <div className="inline-flex items-center gap-2 bg-amber-500/20 text-amber-500 px-3 py-1.5 rounded-lg text-sm font-bold tracking-wide border border-amber-500/30">
            <ShieldAlert size={16} /> {t('admin.panel')}
          </div>
        </div>
        <nav className="flex-1 px-4 space-y-2 overflow-y-auto mt-2">
          <button onClick={() => { setActiveTab('USERS'); setSelectedUser(null); setIsMobileSidebarOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium transition-colors ${activeTab === 'USERS' || activeTab === 'USER_FILES' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}>
            <Users size={20} /> {t('admin.users')}
          </button>
          <button onClick={() => { setActiveTab('SETTINGS'); setIsMobileSidebarOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium transition-colors ${activeTab === 'SETTINGS' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}>
            <Settings size={20} /> {t('admin.systemSettings')}
          </button>
          <div className="pt-4 mt-4 border-t border-slate-800" />
          <button onClick={() => router.push('/')} className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium text-slate-300 hover:bg-white/5 hover:text-white transition-colors">
            <ArrowLeft size={20} /> {t('admin.backHome')}
          </button>
        </nav>
        <div className="p-4 border-t border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center flex-shrink-0"><User size={20} className="text-slate-400" /></div>
            <div className="overflow-hidden">
              <p className="font-medium text-white truncate text-sm">{user?.username}</p>
              <button onClick={() => { logout(); router.push('/login'); }} className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1 mt-1"><LogOut size={12} /> {t('admin.logout')}</button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0 bg-gray-50 relative">
        <header className="md:hidden h-16 border-b border-gray-200 flex items-center px-4 bg-white flex-shrink-0 z-10 w-full">
          <button className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-lg" onClick={() => setIsMobileSidebarOpen(true)}><Menu size={24} /></button>
          <h2 className="text-lg font-bold ml-2 text-gray-800">Admin Panel</h2>
        </header>

        <div className="flex-1 overflow-auto p-4 md:p-6 lg:p-8">
          {activeTab === 'SETTINGS' && (
            <SystemSettings settings={settings} editingSettings={editingSettings} t={t} formatBytes={formatBytes}
              onSettingChange={(key, value) => setEditingSettings({ ...editingSettings, [key]: value })}
              onUpdateSetting={handleUpdateSetting} />
          )}

          {(activeTab === 'USERS' || activeTab === 'USER_FILES') && (
            <UserManagement users={users} selectedUser={selectedUser} currentUserId={user?.id} locale={locale} t={t} formatBytes={formatBytes}
              onSelectUser={(u) => { setSelectedUser(u); setActiveTab('USER_FILES'); fetchUserFiles(u.id); }}
              onBack={() => { setActiveTab('USERS'); setSelectedUser(null); }}
              onEditUser={(u) => { setEditingUser(u); setEditForm({ quotaGB: Number(u.quota) / (1024 ** 3), bandwidthLimitGB: u.dailyBandwidthLimit ? Number(u.dailyBandwidthLimit) / (1024 ** 3) : 0, role: u.role }); }}
              onResetPassword={(u) => { setResetPwUser(u); setResetPwForm({ newPassword: '', confirmPassword: '' }); }}
              onDeleteUser={handleDeleteUser} userFiles={userFiles} onDeleteUserFile={handleDeleteUserFile} />
          )}
        </div>
      </main>

      {/* Edit User Modal */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden relative">
            <div className="p-6 border-b border-gray-100">
              <h3 className="text-lg font-bold text-gray-800">{t('admin.editUser', { username: editingUser.username })}</h3>
              <button className="absolute top-6 right-6 text-gray-400 hover:text-gray-600" onClick={() => setEditingUser(null)}><X size={20} /></button>
            </div>
            <form onSubmit={handleEditUserSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('admin.roleLabel')}</label>
                <select value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })} disabled={user?.id === editingUser.id}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none disabled:bg-gray-100">
                  <option value="USER">{t('admin.userRole')}</option><option value="ADMIN">{t('admin.adminRole')}</option>
                </select>
                {user?.id === editingUser.id && <p className="text-xs text-orange-500 mt-1">{t('admin.cannotDemoteSelf')}</p>}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('admin.maxQuota')}</label>
                <input type="number" min="0" step="0.1" value={editForm.quotaGB} onChange={(e) => setEditForm({ ...editForm, quotaGB: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('admin.bandwidthLimit')}</label>
                <input type="number" min="0" step="0.1" value={editForm.bandwidthLimitGB} onChange={(e) => setEditForm({ ...editForm, bandwidthLimitGB: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none" placeholder={t('admin.bandwidthNoLimit')} />
                <p className="text-xs text-gray-500 mt-1">{t('admin.zeroNoLimit')}</p>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button type="button" onClick={() => setEditingUser(null)} className="px-4 py-2 text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors">{t('admin.cancel')}</button>
                <button type="submit" className="px-4 py-2 text-white bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors">{t('admin.save')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {resetPwUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden relative">
            <div className="p-6 border-b border-gray-100">
              <h3 className="text-lg font-bold text-gray-800">{t('admin.resetPasswordTitle', { username: resetPwUser.username })}</h3>
              <button className="absolute top-6 right-6 text-gray-400 hover:text-gray-600" onClick={() => setResetPwUser(null)}><X size={20} /></button>
            </div>
            <form onSubmit={handleAdminResetPassword} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('password.newPassword')}</label>
                <input type="password" value={resetPwForm.newPassword} onChange={(e) => setResetPwForm({ ...resetPwForm, newPassword: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none" required minLength={4} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('password.confirmNewPassword')}</label>
                <input type="password" value={resetPwForm.confirmPassword} onChange={(e) => setResetPwForm({ ...resetPwForm, confirmPassword: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none" required minLength={4} />
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button type="button" onClick={() => setResetPwUser(null)} className="px-4 py-2 text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors">{t('admin.cancel')}</button>
                <button type="submit" disabled={resetPwLoading} className="px-4 py-2 text-white bg-orange-600 hover:bg-orange-700 disabled:opacity-50 rounded-lg font-medium transition-colors">
                  {resetPwLoading ? t('password.changing') : t('admin.resetPasswordButton')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
