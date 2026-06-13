import axios from 'axios';

export interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
  total: number;
}

export interface ConflictInfo {
  type: 'file' | 'folder';
  id: string;
  name: string;
  suggestedName: string;
  existingItemId: string;
}

export function formatBytes(bytes: string | number): string {
  const size = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(size) / Math.log(k));
  const safeIndex = Math.min(i, sizes.length - 1);
  return parseFloat((size / Math.pow(k, safeIndex)).toFixed(2)) + ' ' + sizes[safeIndex];
}

/** @deprecated Use formatBytes */
export const formatSize = formatBytes;

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    return error.response?.data?.message || fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

export function formatBandwidthResetTime(resetAt: string | null | undefined, locale?: string): string {
  if (!resetAt) return '';
  const date = new Date(resetAt);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleString(locale);
}

export function parseBandwidthError(error: unknown): { resetTime: string } | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 429) return null;
  const resetTime = formatBandwidthResetTime(error.response.headers?.['x-bandwidth-reset']);
  return { resetTime };
}

/** @alias parseBandwidthError */
export const handleBandwidthError = parseBandwidthError;

export function isConflictError(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    return error.response?.status === 409 && !!error.response?.data?.type;
  }
  return false;
}

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
