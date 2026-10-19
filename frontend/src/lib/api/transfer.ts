import { api, transferApi, API_URL } from './client';
import { ensureTransferOrigin } from './client-config';

export interface SignedDownloadUrl {
  url: string;
  expiresAt: string;
}

export interface StreamCookieResponse {
  expiresAt: string;
  ttl: number;
}

export interface DownloadZipPart {
  index: number;
  size: string;
  downloadUrl: string;
}

export interface DownloadZipStatus {
  jobId: string;
  status: string;
  totalFiles: number;
  processedFiles: number;
  totalSize: string;
  parts: DownloadZipPart[];
  expiresAt: string | null;
  error: string | null;
}

// Data-plane calls dùng transferApi; baseURL do config runtime từ backend
// quyết định (xem client-config.ts). Chưa resolve → fallback API_URL →
// hành vi single-origin không đổi.
export async function requestDownloadToken(fileId: string): Promise<SignedDownloadUrl> {
  const res = await transferApi.post(`/transfer/${fileId}/download-token`);
  return res.data;
}

export async function requestShareDownloadToken(shareToken: string): Promise<SignedDownloadUrl> {
  const res = await transferApi.post(`/transfer/share/${shareToken}/download-token`);
  return res.data;
}

// download-token issuance là control-plane (NestJS core) — Go không có route
// này. Dùng api (CORE); token trả về đã trỏ data-plane qua buildTransferUrl.
export async function requestShareFolderDownloadToken(shareToken: string, fileId: string): Promise<SignedDownloadUrl> {
  const res = await api.post(`/folders/share/${shareToken}/download-token/${fileId}`);
  return res.data;
}

export async function requestStreamCookie(): Promise<StreamCookieResponse> {
  const res = await transferApi.post('/transfer/stream-cookie', {}, { withCredentials: true });
  return res.data;
}

export async function requestGuestStreamCookie(): Promise<StreamCookieResponse> {
  const res = await transferApi.post('/transfer/stream-cookie/guest', {}, { withCredentials: true });
  return res.data;
}

export async function clearStreamCookie(): Promise<void> {
  await transferApi.delete('/transfer/stream-cookie', { withCredentials: true });
}

// URL stream phải chờ config runtime (async) để trùng origin với stream cookie
// do transferApi phát hành — lệch origin ⇒ 401 cross-site.
export async function getStreamUrl(fileId: string): Promise<string> {
  return `${await ensureTransferOrigin()}/transfer/stream/${fileId}`;
}

export async function getShareStreamUrl(shareToken: string): Promise<string> {
  return `${await ensureTransferOrigin()}/transfer/share/stream/${shareToken}`;
}

export async function getShareFolderStreamUrl(shareToken: string, fileId: string): Promise<string> {
  return `${await ensureTransferOrigin()}/folders/share/${shareToken}/stream/${fileId}`;
}

/** @deprecated Use requestDownloadToken */
export function getDownloadUrl(fileId: string, token: string) {
  return `${API_URL}/files/${fileId}/download?token=${token}`;
}

export async function createDownloadZip(fileIds?: string[], folderIds?: string[]) {
  const res = await api.post('/transfer/download-zip', { fileIds, folderIds });
  return res.data as { jobId: string };
}

export async function createSharedDownloadZip(shareToken: string, fileIds?: string[], folderIds?: string[]) {
  const res = await api.post('/transfer/download-zip/shared', { shareToken, fileIds, folderIds });
  return res.data as { jobId: string };
}

export async function getDownloadZipStatus(jobId: string): Promise<DownloadZipStatus> {
  const res = await api.get(`/transfer/download-zip/${jobId}/status`);
  return res.data;
}
