import axios from 'axios';
import type { FileRecord, FolderRecord, BreadcrumbItem, TrashedFile, TrashedFolder, AdminUser, AdminSetting, AdminUserFile } from './types';
import toast from 'react-hot-toast';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

/** Resolve API_URL to a full URL (for display/copy purposes, e.g. S3 endpoint) */
export function getAbsoluteApiUrl(): string {
  if (typeof window === 'undefined') return API_URL;
  if (/^https?:\/\//.test(API_URL)) return API_URL;
  return `${window.location.origin}${API_URL}`;
}

/**
 * Pre-configured axios instance.
 * Auth headers are handled globally by the axios interceptor in auth-context.tsx,
 * so callers don't need to pass tokens manually.
 */
const api = axios;

// ── Helpers ──────────────────────────────────────────────────────────────────

export function formatBytes(bytes: string | number): string {
  const size = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(size) / Math.log(k));
  const safeIndex = Math.min(i, sizes.length - 1);
  return parseFloat((size / Math.pow(k, safeIndex)).toFixed(2)) + ' ' + sizes[safeIndex];
}

/** @deprecated Use formatBytes instead */
export const formatSize = formatBytes;

// ── User / Quota ─────────────────────────────────────────────────────────────

export async function fetchCurrentUser() {
  const res = await api.get(`${API_URL}/users/me`);
  return res.data;
}

// ── Folder Content ───────────────────────────────────────────────────────────

export async function fetchFolderContent(folderId?: string): Promise<{ folders: FolderRecord[]; files: FileRecord[] }> {
  const url = folderId
    ? `${API_URL}/folders/content?folderId=${folderId}`
    : `${API_URL}/folders/content`;
  const res = await api.get(url);
  return res.data;
}

export async function fetchBreadcrumbs(folderId: string): Promise<BreadcrumbItem[]> {
  const res = await api.get(`${API_URL}/folders/${folderId}/breadcrumbs`);
  return res.data;
}

// ── Folder CRUD ──────────────────────────────────────────────────────────────

export async function createFolder(name: string, parentId?: string) {
  const res = await api.post(`${API_URL}/folders`, { name, parentId });
  return res.data;
}

export async function deleteFolder(id: string) {
  return api.delete(`${API_URL}/folders/${id}`);
}

export async function restoreFolder(id: string) {
  return api.patch(`${API_URL}/folders/${id}/restore`);
}

export async function permanentDeleteFolder(id: string) {
  return api.delete(`${API_URL}/folders/${id}/permanent`);
}

export async function renameItem(type: 'file' | 'folder', id: string, name: string) {
  const endpoint = type === 'folder' ? 'folders' : 'files';
  return api.patch(`${API_URL}/${endpoint}/${id}/rename`, { name });
}

export async function moveItem(type: 'file' | 'folder', id: string, destinationId: string | null) {
  const endpoint = type === 'folder' ? 'folders' : 'files';
  return api.patch(`${API_URL}/${endpoint}/${id}/move`, {
    folderId: destinationId,
    parentId: destinationId,
  });
}

// ── File Operations ──────────────────────────────────────────────────────────

export async function deleteFile(id: string) {
  return api.delete(`${API_URL}/files/${id}`);
}

export async function restoreFile(id: string) {
  return api.patch(`${API_URL}/files/${id}/restore`);
}

export async function permanentDeleteFile(id: string) {
  return api.delete(`${API_URL}/files/${id}/permanent`);
}

export async function abortUpload(fileId: string) {
  return api.post(`${API_URL}/files/upload/${fileId}/abort`);
}

// ── Signed Download URL ─────────────────────────────────────────────────────

export interface SignedDownloadUrl {
  url: string;
  expiresAt: string;
}

export interface StreamCookieResponse {
  expiresAt: string;
  ttl: number;
}

/** Lấy signed download URL cho user (auth required) */
export async function requestDownloadToken(fileId: string): Promise<SignedDownloadUrl> {
  const res = await api.post(`${API_URL}/files/${fileId}/download-token`);
  return res.data;
}

/** Lấy signed download URL cho shared file (public) */
export async function requestShareDownloadToken(shareToken: string): Promise<SignedDownloadUrl> {
  const res = await api.post(`${API_URL}/files/share/${shareToken}/download-token`);
  return res.data;
}

/** Lấy signed download URL cho file trong shared folder (public) */
export async function requestShareFolderDownloadToken(shareToken: string, fileId: string): Promise<SignedDownloadUrl> {
  const res = await api.post(`${API_URL}/folders/share/${shareToken}/download-token/${fileId}`);
  return res.data;
}

// ── Stream Cookie ───────────────────────────────────────────────────────────

/** Yêu cầu stream cookie (auth required) — backend set HttpOnly cookie */
export async function requestStreamCookie(): Promise<StreamCookieResponse> {
  const res = await api.post(`${API_URL}/files/stream-cookie`, {}, { withCredentials: true });
  return res.data;
}

/** Yêu cầu guest stream cookie (public) */
export async function requestGuestStreamCookie(): Promise<StreamCookieResponse> {
  const res = await api.post(`${API_URL}/files/stream-cookie/guest`, {}, { withCredentials: true });
  return res.data;
}

/** Xoá stream cookie */
export async function clearStreamCookie(): Promise<void> {
  await api.delete(`${API_URL}/files/stream-cookie`, { withCredentials: true });
}

/** Build stream URL (cookie-based, no token in URL) */
export function getStreamUrl(fileId: string): string {
  return `${API_URL}/files/stream/${fileId}`;
}

/** Build share stream URL */
export function getShareStreamUrl(shareToken: string): string {
  return `${API_URL}/files/share/stream/${shareToken}`;
}

/** Build share folder stream URL */
export function getShareFolderStreamUrl(shareToken: string, fileId: string): string {
  return `${API_URL}/folders/share/${shareToken}/stream/${fileId}`;
}

/** @deprecated — dùng requestDownloadToken thay thế */
export function getDownloadUrl(fileId: string, token: string) {
  return `${API_URL}/files/${fileId}/download?token=${token}`;
}

// ── Share ────────────────────────────────────────────────────────────────────

export async function shareItem(type: 'file' | 'folder', id: string) {
  const endpoint = type === 'folder' ? 'folders' : 'files';
  return api.post(`${API_URL}/${endpoint}/${id}/share`);
}

export async function unshareItem(type: 'file' | 'folder', id: string) {
  const endpoint = type === 'folder' ? 'folders' : 'files';
  return api.post(`${API_URL}/${endpoint}/${id}/unshare`);
}

// ── Trash ────────────────────────────────────────────────────────────────────

export async function fetchTrash(): Promise<{ files: TrashedFile[]; folders: TrashedFolder[] }> {
  const [filesRes, foldersRes] = await Promise.all([
    api.get(`${API_URL}/files/trash/list`),
    api.get(`${API_URL}/folders/trash/list`),
  ]);
  return { files: filesRes.data, folders: foldersRes.data };
}

export async function emptyTrash() {
  return api.delete(`${API_URL}/files/trash/empty`);
}

// ── Admin ────────────────────────────────────────────────────────────────────

export async function fetchUsers(): Promise<AdminUser[]> {
  const res = await api.get(`${API_URL}/users`);
  return res.data;
}

// ── Password Management ─────────────────────────────────────────────────────

export async function changePassword(currentPassword: string, newPassword: string) {
  return api.patch(`${API_URL}/users/me/password`, { currentPassword, newPassword });
}

export async function adminResetPassword(userId: string, newPassword: string) {
  return api.patch(`${API_URL}/users/${userId}/password`, { newPassword });
}

export async function fetchSettings(): Promise<AdminSetting[]> {
  const res = await api.get(`${API_URL}/settings`);
  return res.data;
}

export async function updateSetting(key: string, value: string) {
  return api.put(`${API_URL}/settings/${key}`, { value });
}

export async function updateUserRole(userId: string, role: string) {
  return api.patch(`${API_URL}/users/${userId}/role`, { role });
}

export async function updateUserQuota(userId: string, quota: string) {
  return api.patch(`${API_URL}/users/${userId}/quota`, { quota });
}

export async function updateUserBandwidth(userId: string, dailyBandwidthLimit: string | null) {
  return api.patch(`${API_URL}/users/${userId}/bandwidth-limit`, { dailyBandwidthLimit });
}

export async function deleteUser(userId: string) {
  return api.delete(`${API_URL}/users/${userId}`);
}

export async function fetchUserFiles(userId: string): Promise<AdminUserFile[]> {
  const res = await api.get(`${API_URL}/users/${userId}/files`);
  return res.data;
}

export async function deleteUserFile(userId: string, fileId: string) {
  return api.delete(`${API_URL}/users/${userId}/files/${fileId}`);
}

// ── S3 Credentials ──────────────────────────────────────────────────────────

export async function fetchS3Credentials() {
  const res = await api.get(`${API_URL}/s3-credentials`);
  return res.data;
}

export async function createS3Credential(label: string) {
  const res = await api.post(`${API_URL}/s3-credentials`, { label });
  return res.data;
}

export async function deleteS3Credential(id: string) {
  return api.delete(`${API_URL}/s3-credentials/${id}`);
}

// ── Upload Config ────────────────────────────────────────────────────────────

export async function fetchUploadConfig() {
  const res = await api.get(`${API_URL}/files/config`);
  return res.data;
}

// ── Error Helper ────────────────────────────────────────────────────────────

/** Extract API error message from axios errors safely (no `any` needed). */
export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    return error.response?.data?.message || fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

/**
 * Format thời điểm reset bandwidth thành chuỗi ngày+giờ.
 * Trả về '' nếu input không hợp lệ.
 */
export function formatBandwidthResetTime(resetAt: string | null | undefined, locale?: string): string {
  if (!resetAt) return '';
  const date = new Date(resetAt);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleString(locale);
}

// ── Bandwidth Error Handler ──────────────────────────────────────────────────

/** Parse thông tin lỗi 429 từ axios error. Trả null nếu không phải 429. */
export function parseBandwidthError(error: unknown): { resetTime: string } | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 429) return null;
  const resetTime = formatBandwidthResetTime(error.response.headers?.['x-bandwidth-reset']);
  return { resetTime };
}

/** Kiểm tra lỗi 429 — trả { resetTime } hoặc null. Caller hiển thị toast với i18n. */
export function handleBandwidthError(error: unknown): { resetTime: string } | null {
  return parseBandwidthError(error);
}
