import axios, { type AxiosInstance } from 'axios';
import type { FileRecord, FolderRecord, BreadcrumbItem, TrashedFile, TrashedFolder, AdminUser, AdminSetting, AdminUserFile, AdminLogFile, ReadAdminLogsResponse, AdminDashboardSummary, AdminUserBasic } from './types';
import toast from 'react-hot-toast';
import { incPendingCount, decPendingCount } from './request-tracker';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

/** Resolve API_URL to a full URL (for display/copy purposes, e.g. S3 endpoint) */
export function getAbsoluteApiUrl(): string {
  if (typeof window === 'undefined') return API_URL;
  if (/^https?:\/\//.test(API_URL)) return API_URL;
  return `${window.location.origin}${API_URL}`;
}

/**
 * Pre-configured axios instance with timeout and request tracking.
 * Auth headers are handled globally by the axios interceptor in auth-context.tsx,
 * so callers don't need to pass tokens manually.
 */
export const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 30000,
});

// Request interceptor: track pending count for loading overlay
api.interceptors.request.use(
  (config) => {
    incPendingCount();
    return config;
  },
  (error) => {
    decPendingCount();
    return Promise.reject(error);
  },
);

// Response interceptor: decrement pending count + handle timeout/network errors
api.interceptors.response.use(
  (response) => {
    decPendingCount();
    return response;
  },
  (error) => {
    decPendingCount();
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        toast.error('Yêu cầu hết thời gian. Vui lòng thử lại.');
      } else if (!error.response) {
        toast.error('Lỗi kết nối. Kiểm tra mạng của bạn.');
      }
    }
    return Promise.reject(error);
  },
);

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
  const res = await api.get(`/users/me`);
  return res.data;
}

// ── Folder Content ───────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
  total: number;
}

export interface PaginatedFolderContent {
  folders: FolderRecord[];
  files: FileRecord[];
  nextFolderCursor: string | null;
  nextFileCursor: string | null;
  totalFolders: number | 0;
  totalFiles: number | 0;
}

export async function fetchFolderContent(
  folderId?: string,
  cursor?: string,
  search?: string,
): Promise<PaginatedFolderContent & { data: FolderRecord[] | FileRecord[] }> {
  const params = new URLSearchParams();
  if (folderId) params.set('folderId', folderId);
  if (cursor) params.set('cursor', cursor);
  if (search) params.set('search', search);
  params.set('limit', '50');
  const res = await api.get(`/folders/content?${params}`);
  const result = res.data;
  // Flatten folders + files for useServerPagination
  return {
    data: [...(result.folders || []), ...(result.files || [])] as FolderRecord[] | FileRecord[],
    nextCursor: result.nextFolderCursor || result.nextFileCursor || null,
    total: (result.totalFolders || 0) + (result.totalFiles || 0),
    folders: result.folders || [],
    files: result.files || [],
    nextFolderCursor: result.nextFolderCursor,
    nextFileCursor: result.nextFileCursor,
    totalFolders: result.totalFolders || 0,
    totalFiles: result.totalFiles || 0,
  } as PaginatedFolderContent & { data: FolderRecord[] | FileRecord[] };
}

export async function fetchFolderContentInitial(
  folderId?: string,
  search?: string,
): Promise<PaginatedFolderContent> {
  const params = new URLSearchParams();
  if (folderId) params.set('folderId', folderId);
  if (search) params.set('search', search);
  params.set('limit', '50');
  const res = await api.get(`/folders/content?${params}`);
  const result = res.data;
  return result;
}

export async function fetchFolderContentNextPage(
  folderId: string | undefined,
  nextFolderCursor: string | null,
  nextFileCursor: string | null,
  search?: string,
): Promise<{ folders: FolderRecord[]; files: FileRecord[]; nextFolderCursor: string | null; nextFileCursor: string | null }> {
  const params = new URLSearchParams();
  if (folderId) params.set('folderId', folderId);
  const cursor = nextFolderCursor ? nextFolderCursor : nextFileCursor;
  if (cursor) params.set('cursor', cursor);
  if (search) params.set('search', search);
  params.set('limit', '50');
  const res = await api.get(`/folders/content?${params}`);
  return res.data;
}

export async function fetchBreadcrumbs(folderId: string): Promise<BreadcrumbItem[]> {
  const res = await api.get(`/folders/${folderId}/breadcrumbs`);
  return res.data;
}

// ── Folder CRUD ──────────────────────────────────────────────────────────────

export async function createFolder(name: string, parentId?: string) {
  const res = await api.post(`/folders`, { name, parentId });
  return res.data;
}

export async function deleteFolder(id: string) {
  return api.delete(`/folders/${id}`);
}

export async function restoreFolder(id: string) {
  return api.patch(`/folders/${id}/restore`);
}

export async function permanentDeleteFolder(id: string) {
  return api.delete(`/folders/${id}/permanent`);
}

export async function renameItem(type: 'file' | 'folder', id: string, name: string) {
  const endpoint = type === 'folder' ? 'folders' : 'files';
  return api.patch(`/${endpoint}/${id}/rename`, { name });
}

export async function moveItem(type: 'file' | 'folder', id: string, destinationId: string | null, conflictAction?: 'overwrite' | 'rename' | 'skip' | 'merge' | 'error') {
  const endpoint = type === 'folder' ? 'folders' : 'files';
  return api.patch(`/${endpoint}/${id}/move`, {
    folderId: destinationId,
    parentId: destinationId,
    conflictAction,
  });
}

// ── File Operations ──────────────────────────────────────────────────────────

export async function deleteFile(id: string) {
  return api.delete(`/files/${id}`);
}

export async function restoreFile(id: string) {
  return api.patch(`/files/${id}/restore`);
}

export async function permanentDeleteFile(id: string) {
  return api.delete(`/files/${id}/permanent`);
}

export async function abortUpload(fileId: string) {
  return api.post(`/files/upload/${fileId}/abort`);
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
  const res = await api.post(`/files/${fileId}/download-token`);
  return res.data;
}

/** Lấy signed download URL cho shared file (public) */
export async function requestShareDownloadToken(shareToken: string): Promise<SignedDownloadUrl> {
  const res = await api.post(`/files/share/${shareToken}/download-token`);
  return res.data;
}

/** Lấy signed download URL cho file trong shared folder (public) */
export async function requestShareFolderDownloadToken(shareToken: string, fileId: string): Promise<SignedDownloadUrl> {
  const res = await api.post(`/folders/share/${shareToken}/download-token/${fileId}`);
  return res.data;
}

// ── Stream Cookie ───────────────────────────────────────────────────────────

/** Yêu cầu stream cookie (auth required) — backend set HttpOnly cookie */
export async function requestStreamCookie(): Promise<StreamCookieResponse> {
  const res = await api.post(`/files/stream-cookie`, {}, { withCredentials: true });
  return res.data;
}

/** Yêu cầu guest stream cookie (public) */
export async function requestGuestStreamCookie(): Promise<StreamCookieResponse> {
  const res = await api.post(`/files/stream-cookie/guest`, {}, { withCredentials: true });
  return res.data;
}

/** Xoá stream cookie */
export async function clearStreamCookie(): Promise<void> {
  await api.delete(`/files/stream-cookie`, { withCredentials: true });
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
  return api.post(`/${endpoint}/${id}/share`);
}

export async function unshareItem(type: 'file' | 'folder', id: string) {
  const endpoint = type === 'folder' ? 'folders' : 'files';
  return api.post(`/${endpoint}/${id}/unshare`);
}

// ── Trash ────────────────────────────────────────────────────────────────────

export async function fetchTrashFolders(
  cursor?: string,
  search?: string,
): Promise<PaginatedResponse<TrashedFolder>> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (search) params.set('search', search);
  params.set('limit', '20');
  const res = await api.get(`/folders/trash/list?${params}`);
  return res.data;
}

export async function fetchTrashFiles(
  cursor?: string,
  search?: string,
): Promise<PaginatedResponse<TrashedFile>> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (search) params.set('search', search);
  params.set('limit', '20');
  const res = await api.get(`/files/trash/list?${params}`);
  return res.data;
}

export async function emptyTrash() {
  return api.delete(`/files/trash/empty`);
}

// ── Admin ────────────────────────────────────────────────────────────────────

export async function fetchUsers(
  cursor?: string,
  search?: string,
): Promise<PaginatedResponse<AdminUser>> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (search) params.set('search', search);
  params.set('limit', '20');
  const res = await api.get(`/users?${params}`);
  return res.data;
}

export async function fetchAdminDashboardSummary(): Promise<AdminDashboardSummary> {
  const res = await api.get('/admin/dashboard');
  return res.data;
}

// ── Password Management ─────────────────────────────────────────────────────

export async function changePassword(currentPassword: string, newPassword: string) {
  return api.patch(`/users/me/password`, { currentPassword, newPassword });
}

export async function adminResetPassword(userId: string, newPassword: string) {
  return api.patch(`/users/${userId}/password`, { newPassword });
}

export async function fetchSettings(): Promise<AdminSetting[]> {
  const res = await api.get(`/settings`);
  return res.data;
}

export async function updateSetting(key: string, value: string) {
  return api.put(`/settings/${key}`, { value });
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

export async function fetchAdminUserBasic(userId: string): Promise<AdminUserBasic> {
  const res = await api.get(`/users/${userId}/basic`);
  return res.data;
}

export async function fetchUserFiles(
  userId: string,
  cursor?: string,
  search?: string,
): Promise<PaginatedResponse<AdminUserFile>> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (search) params.set('search', search);
  params.set('limit', '20');
  const res = await api.get(`/users/${userId}/files?${params}`);
  return res.data;
}

export async function deleteUserFile(userId: string, fileId: string) {
  return api.delete(`/users/${userId}/files/${fileId}`);
}

export async function updateAdminUserFileDownloadPolicy(
  userId: string,
  fileId: string,
  body: {
    downloadLimit24h: number | null;
    bandwidthLimit24h: string | null;
  },
) {
  const res = await api.patch(`/users/${userId}/files/${fileId}/download-policy`, body);
  return res.data;
}

export async function fetchAdminLogFiles(): Promise<AdminLogFile[]> {
  const res = await api.get('/admin/logs/files');
  return res.data;
}

export async function readAdminLogs(params: {
  file: string;
  limit?: number;
  level?: string;
  search?: string;
  newestFirst?: boolean;
  filters?: Array<{
    field: 'timestamp' | 'level' | 'context' | 'message' | 'stack' | 'raw';
    value: string;
    negated?: boolean;
  }>;
}): Promise<ReadAdminLogsResponse> {
  const query = new URLSearchParams();
  query.set('file', params.file);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.level) query.set('level', params.level);
  if (params.search) query.set('search', params.search);
  if (params.newestFirst) query.set('newestFirst', 'true');
  if (params.filters && params.filters.length > 0) {
    query.set('filters', JSON.stringify(params.filters));
  }

  const res = await api.get(`/admin/logs/read?${query}`);
  return res.data;
}

// ── S3 Credentials ──────────────────────────────────────────────────────────

export async function fetchS3Credentials() {
  const res = await api.get(`/s3-credentials`);
  return res.data;
}

export async function createS3Credential(label: string) {
  const res = await api.post(`/s3-credentials`, { label });
  return res.data;
}

export async function deleteS3Credential(id: string) {
  return api.delete(`/s3-credentials/${id}`);
}

// ── Upload Config ────────────────────────────────────────────────────────────

export async function fetchUploadConfig() {
  const res = await api.get(`/files/config`);
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

// ── Conflict Helpers ──────────────────────────────────────────────────────────

export interface ConflictInfo {
  type: 'file' | 'folder';
  id: string;
  name: string;
  suggestedName: string;
  existingItemId: string;
}

/** Kiểm tra lỗi có phải là 409 Conflict chứa ConflictResponseDto không. */
export function isConflictError(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    return error.response?.status === 409 && !!error.response?.data?.type;
  }
  return false;
}

/** Trích xuất ConflictInfo từ axios error. Trả null nếu không phải 409 conflict. */
export function parseConflictResponse(error: unknown): ConflictInfo | null {
  if (!isConflictError(error)) return null;
  const data = (error as { response?: { data?: Record<string, unknown> } }).response?.data;
  if (!data || typeof data !== 'object') return null;
  return {
    type: data.type as 'file' | 'folder',
    id: data.id as string,
    name: data.name as string,
    suggestedName: data.suggestedName as string,
    existingItemId: data.existingItemId as string,
  };
}

/** Trạng thái dọn dẹp thùng rác */
export interface TrashCleanupStatus {
  isCleaning: boolean;
  deletedCount?: number;
  totalCount?: number;
}

/** Lấy trạng thái dọn dẹp thùng rác */
export async function getCleanupStatus(): Promise<TrashCleanupStatus> {
  const res = await api.get(`/files/trash/cleanup-status`);
  return res.data;
}

/** Bắt đầu dọn dẹp thùng rác bất đồng bộ (trả 202) */
export async function startCleanup(): Promise<void> {
  await api.post(`/files/trash/cleanup`);
}
