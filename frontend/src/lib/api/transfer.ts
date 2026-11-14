import { api, transferApi, API_URL, resolveTransferLink } from './client';
import { ensureTransferOrigin } from './client-config';

export interface SignedDownloadUrl {
  url: string;
  expiresAt: string;
}

export interface SignedPreviewUrl extends SignedDownloadUrl {
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

/**
 * Mint a short-lived, file-scoped URL for browser media/PDF preview.
 * Unlike the legacy stream-cookie flow, the returned URL is self-authenticating
 * and can be requested by native media elements that cannot attach JWT headers.
 */
export async function requestPreviewToken(fileId: string): Promise<SignedPreviewUrl> {
  const res = await transferApi.post(`/transfer/${fileId}/preview-token`);
  return res.data;
}

export async function getPreviewUrl(fileId: string): Promise<SignedPreviewUrl> {
  const preview = await requestPreviewToken(fileId);
  return { ...preview, url: resolveTransferLink(preview.url) };
}

export async function requestShareDownloadToken(shareToken: string): Promise<SignedDownloadUrl> {
  const res = await transferApi.post(`/transfer/share/${shareToken}/download-token`);
  return res.data;
}

export async function requestSharePreviewToken(shareToken: string): Promise<SignedPreviewUrl> {
  const res = await transferApi.post(`/transfer/share/${shareToken}/preview-token`);
  return res.data;
}

export async function getSharePreviewUrl(shareToken: string): Promise<SignedPreviewUrl> {
  const preview = await requestSharePreviewToken(shareToken);
  return { ...preview, url: resolveTransferLink(preview.url) };
}

// download-token issuance là control-plane (NestJS core) — Go không có route
// này. Dùng api (CORE); token trả về đã trỏ data-plane qua buildTransferUrl.
export async function requestShareFolderDownloadToken(shareToken: string, fileId: string): Promise<SignedDownloadUrl> {
  const res = await api.post(`/folders/share/${shareToken}/download-token/${fileId}`);
  return res.data;
}

// Kept while legacy private stream-cookie routes remain available for rollback.
// New previews do not depend on this cookie, but logout must still revoke any
// cookie issued by an older frontend or another open tab.
export async function clearStreamCookie(): Promise<void> {
  await transferApi.delete('/transfer/stream-cookie', { withCredentials: true });
}

// Public stream URLs must use the runtime transfer origin so they remain valid
// when the data plane is hosted separately from the control-plane app.
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
  const res = await api.get(`/transfer/download-zip/${jobId}/status`, { skipRequestOverlay: true });
  return res.data;
}
