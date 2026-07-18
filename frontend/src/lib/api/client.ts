import axios, { type AxiosInstance } from 'axios';
import toast from 'react-hot-toast';
import { incPendingCount, decPendingCount } from '@/providers/request-tracker';
import { API_TIMEOUT_MS } from '@/lib/constants';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Data-plane origin (e.g. transfer.example.com) for stream/download/config
// calls. Falls back to API_URL when unset → single-origin behavior unchanged
// (zero regression). Baked at build time.
export const TRANSFER_URL = process.env.NEXT_PUBLIC_TRANSFER_URL || API_URL;

// Dedicated S3 domain (e.g. s3.example.com) served by the nginx S3 server
// block. Baked at build time. This is the ONLY S3-compatible endpoint: the
// app-domain `{origin}/s3` path was removed because SigV4 binds Host + URI and
// cannot be routed to the Go data plane behind the app domain.
export const S3_DOMAIN = process.env.NEXT_PUBLIC_S3_DOMAIN || '';

export function getAbsoluteApiUrl(): string {
  if (typeof window === 'undefined') return API_URL;
  if (/^https?:\/\//.test(API_URL)) return API_URL;
  return `${window.location.origin}${API_URL}`;
}

// Resolve a backend-emitted data-plane link (download token, zip part) to a
// fetchable URL. NestJS emits absolute transfer-origin URLs when
// PUBLIC_TRANSFER_URL is set (Phase 3) → pass through as-is; otherwise emits a
// relative path (`/files/d/…`, `/transfer/download-zip/…`) → prefix the
// data-plane origin (TRANSFER_URL), NOT API_URL. Fallback (TRANSFER_URL ===
// API_URL) keeps today's single-origin behavior byte-for-byte.
export function resolveTransferLink(url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  return `${TRANSFER_URL}${url}`;
}

// The S3-compatible endpoint to surface on the keys page: the dedicated S3
// domain, or null when NEXT_PUBLIC_S3_DOMAIN is not configured.
export function getS3Endpoint(): string | null {
  if (!S3_DOMAIN) return null;
  return /^https?:\/\//.test(S3_DOMAIN) ? S3_DOMAIN : `https://${S3_DOMAIN}`;
}

// Gắn interceptor pending-tracking + toast lỗi dùng chung cho mọi axios
// instance (DRY) — dùng cho cả `api` (control plane) và `transferApi` (data
// plane) để hành vi tracking/error đồng nhất.
function attachSharedInterceptors(instance: AxiosInstance): void {
  instance.interceptors.request.use(
    (config) => { incPendingCount(); return config; },
    (error) => { decPendingCount(); return Promise.reject(error); },
  );

  instance.interceptors.response.use(
    (response) => { decPendingCount(); return response; },
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
}

export const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: API_TIMEOUT_MS,
});

// Data-plane instance. Same interceptors + JWT header as `api` (JWT gắn trong
// auth-context.tsx). Khi TRANSFER_URL === API_URL (fallback) đây chỉ là instance
// thứ hai trỏ cùng origin — không đổi hành vi mạng.
export const transferApi: AxiosInstance = axios.create({
  baseURL: TRANSFER_URL,
  timeout: API_TIMEOUT_MS,
});

attachSharedInterceptors(api);
attachSharedInterceptors(transferApi);
