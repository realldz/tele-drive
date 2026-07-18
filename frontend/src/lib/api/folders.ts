import { api } from './client';
import type { FileRecord, FolderRecord, BreadcrumbItem } from '@/lib/types';
import { PAGINATION_FOLDER_LIMIT } from '@/lib/constants';

export interface PaginatedFolderContent {
  folders: FolderRecord[];
  files: FileRecord[];
  nextFolderCursor: string | null;
  nextFileCursor: string | null;
  totalFolders: number;
  totalFiles: number;
}

export async function fetchFolderContent(
  folderId?: string,
  cursor?: string,
  search?: string,
  sortField?: string,
  sortDirection?: 'asc' | 'desc',
): Promise<PaginatedFolderContent & { data: FolderRecord[] | FileRecord[]; nextCursor: string | null; total: number }> {
  const params = new URLSearchParams();
  if (folderId) params.set('folderId', folderId);
  if (cursor) params.set('cursor', cursor);
  if (search) params.set('search', search);
  if (sortField) params.set('sortField', sortField);
  if (sortDirection) params.set('sortDirection', sortDirection);
  params.set('limit', String(PAGINATION_FOLDER_LIMIT));
  const res = await api.get(`/folders/content?${params}`);
  const result = res.data;
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
  };
}

export async function fetchFolderContentInitial(
  folderId?: string,
  search?: string,
  sortField?: string,
  sortDirection?: 'asc' | 'desc',
): Promise<PaginatedFolderContent> {
  const params = new URLSearchParams();
  if (folderId) params.set('folderId', folderId);
  if (search) params.set('search', search);
  if (sortField) params.set('sortField', sortField);
  if (sortDirection) params.set('sortDirection', sortDirection);
  params.set('limit', String(PAGINATION_FOLDER_LIMIT));
  const res = await api.get(`/folders/content?${params}`);
  return res.data;
}

export async function fetchFolderContentNextPage(
  folderId: string | undefined,
  nextFolderCursor: string | null,
  nextFileCursor: string | null,
  search?: string,
  sortField?: string,
  sortDirection?: 'asc' | 'desc',
): Promise<{ folders: FolderRecord[]; files: FileRecord[]; nextFolderCursor: string | null; nextFileCursor: string | null }> {
  const params = new URLSearchParams();
  if (folderId) params.set('folderId', folderId);
  const cursor = nextFolderCursor ?? nextFileCursor;
  if (cursor) params.set('cursor', cursor);
  if (search) params.set('search', search);
  if (sortField) params.set('sortField', sortField);
  if (sortDirection) params.set('sortDirection', sortDirection);
  params.set('limit', String(PAGINATION_FOLDER_LIMIT));
  const res = await api.get(`/folders/content?${params}`);
  return res.data;
}

export interface GlobalSearchParams {
  q?: string;
  type?: 'all' | 'folder' | 'file';
  format?: string;
  createdFrom?: string;
  createdTo?: string;
  cursor?: string | null;
  sortField?: string;
  sortDirection?: 'asc' | 'desc';
}

/**
 * Global search across ALL of the user's files/folders (GET /folders/search).
 * Returns the same PaginatedFolderContent shape as folder browsing so the
 * dashboard grid/list + dual-cursor load-more infra can render it unchanged.
 */
export async function searchFiles(
  params: GlobalSearchParams,
): Promise<PaginatedFolderContent> {
  const p = new URLSearchParams();
  if (params.q) p.set('q', params.q);
  if (params.type && params.type !== 'all') p.set('type', params.type);
  if (params.format) p.set('format', params.format);
  if (params.createdFrom) p.set('createdFrom', params.createdFrom);
  if (params.createdTo) p.set('createdTo', params.createdTo);
  if (params.cursor) p.set('cursor', params.cursor);
  if (params.sortField) p.set('sortField', params.sortField);
  if (params.sortDirection) p.set('sortDirection', params.sortDirection);
  p.set('limit', String(PAGINATION_FOLDER_LIMIT));
  const res = await api.get(`/folders/search?${p}`);
  return res.data;
}

export async function fetchBreadcrumbs(folderId: string): Promise<BreadcrumbItem[]> {
  const res = await api.get(`/folders/${folderId}/breadcrumbs`);
  return res.data;
}

export async function createFolder(name: string, parentId?: string) {
  const res = await api.post('/folders', { name, parentId });
  return res.data;
}

export async function createFolderBatch(paths: string[], parentId?: string): Promise<Record<string, string>> {
  const res = await api.post('/folders/batch', { paths, parentId });
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

export async function moveItem(
  type: 'file' | 'folder',
  id: string,
  destinationId: string | null,
  conflictAction?: 'overwrite' | 'rename' | 'skip' | 'merge' | 'error',
) {
  const endpoint = type === 'folder' ? 'folders' : 'files';
  return api.patch(`/${endpoint}/${id}/move`, {
    folderId: destinationId,
    parentId: destinationId,
    conflictAction,
  });
}

export async function shareItem(type: 'file' | 'folder', id: string) {
  const endpoint = type === 'folder' ? 'folders' : 'files';
  return api.post(`/${endpoint}/${id}/share`);
}

export async function unshareItem(type: 'file' | 'folder', id: string) {
  const endpoint = type === 'folder' ? 'folders' : 'files';
  return api.post(`/${endpoint}/${id}/unshare`);
}

export async function setS3PublicAccess(folderId: string, enabled: boolean, listObjects?: boolean) {
  return api.put(`/folders/${folderId}/s3-public-access`, { enabled, listObjects });
}
