import axios, { type AxiosInstance } from 'axios';
import toast from 'react-hot-toast';
import { incPendingCount, decPendingCount } from '@/providers/request-tracker';
import { API_TIMEOUT_MS } from '@/lib/constants';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ─── Runtime client config ─────────────────────────────────────────────────
// Data-plane origin (dedicated transfer domain) + S3 host. These used to be
// baked at build time (NEXT_PUBLIC_TRANSFER_URL / NEXT_PUBLIC_S3_DOMAIN); they
// are now fetched once from the backend (`GET /client-config`, see
// lib/api/client-config.ts) so flipping the domains no longer requires a
// frontend rebuild. State lives at module scope (not React state) because the
// axios instances + URL builders are plain functions; components subscribe
// through `subscribeClientConfig` (see hooks/use-client-config.ts).
let transferOrigin: string | null = null;
let s3Domain: string | null = null;
const clientConfigListeners = new Set<() => void>();

// Data-plane origin; falls back to API_URL when the backend has no dedicated
// transfer domain → legacy single-origin behavior, byte-for-byte.
export function getTransferUrl(): string {
  return transferOrigin ?? API_URL;
}

// Raw S3 host/origin as configured by the backend; null = not configured.
export function getS3Domain(): string | null {
  return s3Domain;
}

export function subscribeClientConfig(listener: () => void): () => void {
  clientConfigListeners.add(listener);
  return () => {
    clientConfigListeners.delete(listener);
  };
}

// Applies the backend-provided runtime config (called from client-config.ts).
// Also the single place that changes the transferApi baseURL, so every
// data-plane XHR follows the resolved origin.
export function applyClientConfig(config: {
  transferUrl: string | null;
  s3Domain: string | null;
}): void {
  transferOrigin = config.transferUrl
    ? config.transferUrl.replace(/\/+$/, '')
    : null;
  s3Domain = config.s3Domain ? config.s3Domain.replace(/\/+$/, '') : null;
  transferApi.defaults.baseURL = getTransferUrl();
  clientConfigListeners.forEach((listener) => listener());
}

export function getAbsoluteApiUrl(): string {
  if (typeof window === 'undefined') return API_URL;
  if (/^https?:\/\//.test(API_URL)) return API_URL;
  return `${window.location.origin}${API_URL}`;
}

// Resolve a backend-emitted data-plane link (download token, zip part) to a
// fetchable URL. NestJS emits absolute transfer-origin URLs when
// PUBLIC_TRANSFER_URL is set → pass through as-is; otherwise it emits a
// relative path (`/files/d/…`, `/transfer/download-zip/…`) → prefix the
// data-plane origin, NOT API_URL. When no transfer domain is configured the
// origin falls back to API_URL, keeping today's single-origin behavior.
export function resolveTransferLink(url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  return `${getTransferUrl()}${url}`;
}

// Turns the backend-provided S3 host into a full endpoint URL. Accepts a bare
// host (`s3.example.com`) or an already-absolute origin.
export function toS3Endpoint(domain: string | null): string | null {
  if (!domain) return null;
  return /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
}

// The S3-compatible endpoint to surface on the keys page: the backend-provided
// domain, or null when the backend reports S3 as not configured.
export function getS3Endpoint(): string | null {
  return toS3Endpoint(s3Domain);
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
// auth-context.tsx). baseURL starts at API_URL (legacy single origin) and is
// switched to the backend-provided transfer origin by applyClientConfig().
export const transferApi: AxiosInstance = axios.create({
  baseURL: getTransferUrl(),
  timeout: API_TIMEOUT_MS,
});

attachSharedInterceptors(api);
attachSharedInterceptors(transferApi);
