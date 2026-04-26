'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  adminResetPassword,
  deleteUser as deleteUserApi,
  fetchUsers as fetchUsersApi,
  getApiErrorMessage,
  updateUserBandwidth,
  updateUserQuota,
  updateUserRole,
} from '@/lib/api';
import type { AdminUser } from '@/lib/types';
import { useI18n } from '@/components/i18n-context';
import { useAuth } from '@/components/auth-context';
import { useAppNavigate } from '@/hooks/use-app-navigate';
import UserManagement from '../components/user-management';
import EditUserModal from '../components/edit-user-modal';
import ResetPasswordModal from '../components/reset-password-modal';
import ConfirmModal from '../components/confirm-modal';

export default function AdminUsersPage() {
  const navigate = useAppNavigate();
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersCursor, setUsersCursor] = useState<string | null>(null);
  const [usersHasMore, setUsersHasMore] = useState(true);
  const [userSearch, setUserSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersLoadingMore, setUsersLoadingMore] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editForm, setEditForm] = useState<{
    quotaGB: number | string;
    bandwidthLimitGB: number | string;
    role: string;
  }>({ quotaGB: 15, bandwidthLimitGB: 0, role: 'USER' });
  const [resetPwUser, setResetPwUser] = useState<AdminUser | null>(null);
  const [resetPwForm, setResetPwForm] = useState({
    newPassword: '',
    confirmPassword: '',
  });
  const [resetPwLoading, setResetPwLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{
    id: string;
    username: string;
  } | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const ONE_GB = 1024 ** 3;

  const fetchUsers = useCallback(
    async (search?: string) => {
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
      } finally {
        setUsersLoading(false);
      }
    },
    [t],
  );

  const loadMoreUsers = useCallback(async () => {
    if (!usersCursor || usersLoadingMore || !usersHasMore) return;
    setUsersLoadingMore(true);
    try {
      const res = await fetchUsersApi(usersCursor, userSearch || undefined);
      setUsers((prev) => [...prev, ...res.data]);
      setUsersCursor(res.nextCursor);
      setUsersHasMore(res.nextCursor !== null);
    } catch {
      toast.error(t('admin.fetchUsersError'));
    } finally {
      setUsersLoadingMore(false);
    }
  }, [usersCursor, usersLoadingMore, usersHasMore, userSearch, t]);

  const handleUserSearch = useCallback(
    (value: string) => {
      setUserSearch(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void fetchUsers(value.trim() || undefined);
      }, 400);
    },
    [fetchUsers],
  );

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

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
      await fetchUsers(userSearch || undefined);
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('admin.updateUserError')));
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setConfirmLoading(true);
    try {
      await deleteUserApi(confirmDelete.id);
      toast.success(t('admin.deleteUserSuccess'));
      await fetchUsers(userSearch || undefined);
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('admin.deleteUserError')));
    } finally {
      setConfirmLoading(false);
      setConfirmDelete(null);
    }
  };

  const handleAdminResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPwUser) return;
    if (resetPwForm.newPassword !== resetPwForm.confirmPassword) {
      toast.error(t('password.mismatch'));
      return;
    }
    if (resetPwForm.newPassword.length < 4) {
      toast.error(t('password.tooShort'));
      return;
    }
    setResetPwLoading(true);
    try {
      await adminResetPassword(resetPwUser.id, resetPwForm.newPassword);
      toast.success(t('admin.resetPasswordSuccess'));
      setResetPwUser(null);
      setResetPwForm({ newPassword: '', confirmPassword: '' });
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('admin.resetPasswordError')));
    } finally {
      setResetPwLoading(false);
    }
  };

  return (
    <>
      <UserManagement
        users={users}
        currentUserId={user?.id}
        locale={locale}
        t={t}
        loading={usersLoading}
        loadingMore={usersLoadingMore}
        error={usersError}
        usersHasMore={usersHasMore}
        onLoadMoreUsers={loadMoreUsers}
        userSearch={userSearch}
        onUserSearch={handleUserSearch}
        onSelectUser={(u) => navigate.push(`/admin/users/${u.id}/files`)}
        onEditUser={(u) => {
          setEditingUser(u);
          setEditForm({
            quotaGB: Number(u.quota) / ONE_GB,
            bandwidthLimitGB: u.dailyBandwidthLimit
              ? Number(u.dailyBandwidthLimit) / ONE_GB
              : 0,
            role: u.role,
          });
        }}
        onResetPassword={(u) => {
          setResetPwUser(u);
          setResetPwForm({ newPassword: '', confirmPassword: '' });
        }}
        onDeleteUser={(id, username) => setConfirmDelete({ id, username })}
        onRetry={() => void fetchUsers(userSearch || undefined)}
      />

      {editingUser && (
        <EditUserModal
          user={editingUser}
          currentUserId={user?.id}
          form={editForm}
          onFormChange={setEditForm}
          t={t}
          onSubmit={handleEditUserSubmit}
          onClose={() => setEditingUser(null)}
        />
      )}

      {resetPwUser && (
        <ResetPasswordModal
          username={resetPwUser.username}
          form={resetPwForm}
          onFormChange={setResetPwForm}
          loading={resetPwLoading}
          t={t}
          onSubmit={handleAdminResetPassword}
          onClose={() => {
            setResetPwUser(null);
            setResetPwForm({ newPassword: '', confirmPassword: '' });
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title={t('admin.delete')}
          message={t('admin.confirmDeleteUser', { username: confirmDelete.username })}
          loading={confirmLoading}
          t={t}
          onConfirm={handleConfirmDelete}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}
