import { api } from './client';
import type { AdminUser, AdminUserBasic, AdminUserFile } from '@/lib/types';
import type { PaginatedResponse } from './helpers';
import { PAGINATION_DEFAULT_LIMIT } from '@/lib/constants';

export async function fetchCurrentUser() {
  const res = await api.get('/users/me');
  return res.data;
}

export async function fetchUsers(
  cursor?: string,
  search?: string,
): Promise<PaginatedResponse<AdminUser>> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (search) params.set('search', search);
  params.set('limit', String(PAGINATION_DEFAULT_LIMIT));
  const res = await api.get(`/users?${params}`);
  return res.data;
}

export async function fetchAdminUserBasic(userId: string): Promise<AdminUserBasic> {
  const res = await api.get(`/users/${userId}/basic`);
  return res.data;
}

export async function updateCurrentUser(body: { email: string | null }) {
  const res = await api.patch('/users/me', body);
  return res.data;
}

export async function changePassword(currentPassword: string, newPassword: string) {
  return api.patch('/users/me/password', { currentPassword, newPassword });
}

export async function adminResetPassword(userId: string, newPassword: string) {
  return api.patch(`/users/${userId}/password`, { newPassword });
}

export async function updateUserAccount(userId: string, body: { email: string | null }) {
  return api.patch(`/users/${userId}/account`, body);
}

export async function updateUserRole(userId: string, role: string) {
  return api.patch(`/users/${userId}/role`, { role });
}

export async function updateUserQuota(userId: string, quota: string) {
  return api.patch(`/users/${userId}/quota`, { quota });
}

export async function updateUserBandwidth(userId: string, dailyBandwidthLimit: string | null) {
  return api.patch(`/users/${userId}/bandwidth-limit`, { dailyBandwidthLimit });
}

export async function deleteUser(userId: string) {
  return api.delete(`/users/${userId}`);
}

export async function fetchUserFiles(
  userId: string,
  cursor?: string,
  search?: string,
): Promise<PaginatedResponse<AdminUserFile>> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (search) params.set('search', search);
  params.set('limit', String(PAGINATION_DEFAULT_LIMIT));
  const res = await api.get(`/users/${userId}/files?${params}`);
  return res.data;
}

export async function deleteUserFile(userId: string, fileId: string) {
  return api.delete(`/users/${userId}/files/${fileId}`);
}

export async function updateAdminUserFileDownloadPolicy(
  userId: string,
  fileId: string,
  body: { downloadLimit24h: number | null; bandwidthLimit24h: string | null },
) {
  const res = await api.patch(`/users/${userId}/files/${fileId}/download-policy`, body);
  return res.data;
}
