import { api } from './client';
import type { AdminDashboardSummary, AdminLogFile, ReadAdminLogsResponse } from '@/lib/types';

export interface BufferStats {
  bufferedCount: number;
  failedCount: number;
  tempStorageUsedBytes: string;
  oldestBufferedAgeMs: number;
}

export interface ZipStats {
  activeCount: number;
  readyCount: number;
  failedCount: number;
  tempStorageUsedBytes: string;
}

export interface GoWorkerPoolStats {
  size: number;
  activeJobs: number;
  pendingQueue: number;
  delayedQueue: number;
}

export interface GoTelegramStats {
  botCount: number;
  semaphoreUsed: number;
  semaphoreCapacity: number;
}

export interface GoStorageStats {
  bufferUsedBytes: number;
  bufferCapacityBytes: number;
}

export interface GoGrpcStats {
  coreConnected: boolean;
}

export interface GoStats {
  workerPool: GoWorkerPoolStats;
  telegram: GoTelegramStats;
  storage: GoStorageStats;
  grpc: GoGrpcStats;
}

export interface NestJSStats {
  uptime: number;
  memoryRss: string;
  memoryHeapUsed: string;
  memoryHeapTotal: string;
}

export interface SystemStats {
  buffer: BufferStats;
  zip: ZipStats;
  go: GoStats | null;
  nestjs: NestJSStats;
}

export async function fetchAdminDashboardSummary(): Promise<AdminDashboardSummary> {
  const res = await api.get('/admin/dashboard');
  return res.data;
}

export async function fetchSystemStats(): Promise<SystemStats> {
  const res = await api.get('/admin/system-stats');
  return res.data;
}

export async function retryAllFailedBuffers(): Promise<{ retriedCount: number }> {
  const res = await api.post('/admin/buffer-retry');
  return res.data;
}

export async function clearFailedZipJobs(): Promise<{ deletedCount: number }> {
  const res = await api.delete('/admin/zip-failed-jobs');
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
