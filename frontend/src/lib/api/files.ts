import { api } from './client';

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
  return api.post(`/transfer/upload/${fileId}/abort`);
}

export async function retryBuffer(id: string) {
  return api.post(`/transfer/${id}/buffer-retry`);
}
