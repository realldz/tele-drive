import { api } from './client';
import type { TrashedFile, TrashedFolder } from '@/lib/types';
import type { PaginatedResponse } from './helpers';
import { PAGINATION_DEFAULT_LIMIT } from '@/lib/constants';

export interface TrashCleanupStatus {
  isCleaning: boolean;
  deletedCount?: number;
  totalCount?: number;
}

export async function fetchTrashFolders(
  cursor?: string,
  search?: string,
  sortField?: string,
  sortDirection?: 'asc' | 'desc',
): Promise<PaginatedResponse<TrashedFolder>> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (search) params.set('search', search);
  if (sortField) params.set('sortField', sortField);
  if (sortDirection) params.set('sortDirection', sortDirection);
  params.set('limit', String(PAGINATION_DEFAULT_LIMIT));
  const res = await api.get(`/folders/trash/list?${params}`);
  return res.data;
}

export async function fetchTrashFiles(
  cursor?: string,
  search?: string,
  sortField?: string,
  sortDirection?: 'asc' | 'desc',
): Promise<PaginatedResponse<TrashedFile>> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (search) params.set('search', search);
  if (sortField) params.set('sortField', sortField);
  if (sortDirection) params.set('sortDirection', sortDirection);
  params.set('limit', String(PAGINATION_DEFAULT_LIMIT));
  const res = await api.get(`/files/trash/list?${params}`);
  return res.data;
}

export async function emptyTrash() {
  return api.delete('/files/trash/empty');
}

export async function getCleanupStatus(): Promise<TrashCleanupStatus> {
  const res = await api.get('/files/trash/cleanup-status');
  return res.data;
}

export async function startCleanup(): Promise<void> {
  await api.post('/files/trash/cleanup');
}
