import { api, API_URL } from './client';

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

export async function requestDownloadToken(fileId: string): Promise<SignedDownloadUrl> {
  const res = await api.post(`/transfer/${fileId}/download-token`);
  return res.data;
}

export async function requestShareDownloadToken(shareToken: string): Promise<SignedDownloadUrl> {
  const res = await api.post(`/transfer/share/${shareToken}/download-token`);
  return res.data;
}

export async function requestShareFolderDownloadToken(shareToken: string, fileId: string): Promise<SignedDownloadUrl> {
  const res = await api.post(`/folders/share/${shareToken}/download-token/${fileId}`);
  return res.data;
}

export async function requestStreamCookie(): Promise<StreamCookieResponse> {
  const res = await api.post('/transfer/stream-cookie', {}, { withCredentials: true });
  return res.data;
}

export async function requestGuestStreamCookie(): Promise<StreamCookieResponse> {
  const res = await api.post('/transfer/stream-cookie/guest', {}, { withCredentials: true });
  return res.data;
}

export async function clearStreamCookie(): Promise<void> {
  await api.delete('/transfer/stream-cookie', { withCredentials: true });
}

export function getStreamUrl(fileId: string): string {
  return `${API_URL}/transfer/stream/${fileId}`;
}

export function getShareStreamUrl(shareToken: string): string {
  return `${API_URL}/transfer/share/stream/${shareToken}`;
}

export function getShareFolderStreamUrl(shareToken: string, fileId: string): string {
  return `${API_URL}/folders/share/${shareToken}/stream/${fileId}`;
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
