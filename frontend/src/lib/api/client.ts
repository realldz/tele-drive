import axios, { type AxiosInstance } from 'axios';
import toast from 'react-hot-toast';
import { incPendingCount, decPendingCount } from '@/providers/request-tracker';
import { API_TIMEOUT_MS } from '@/lib/constants';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

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

// The S3-compatible endpoint to surface on the keys page: the dedicated S3
// domain, or null when NEXT_PUBLIC_S3_DOMAIN is not configured.
export function getS3Endpoint(): string | null {
  if (!S3_DOMAIN) return null;
  return /^https?:\/\//.test(S3_DOMAIN) ? S3_DOMAIN : `https://${S3_DOMAIN}`;
}

export const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: API_TIMEOUT_MS,
});

api.interceptors.request.use(
  (config) => { incPendingCount(); return config; },
  (error) => { decPendingCount(); return Promise.reject(error); },
);

api.interceptors.response.use(
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
