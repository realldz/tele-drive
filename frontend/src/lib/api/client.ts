import axios, { type AxiosInstance } from 'axios';
import toast from 'react-hot-toast';
import { incPendingCount, decPendingCount } from '@/providers/request-tracker';
import { API_TIMEOUT_MS } from '@/lib/constants';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export function getAbsoluteApiUrl(): string {
  if (typeof window === 'undefined') return API_URL;
  if (/^https?:\/\//.test(API_URL)) return API_URL;
  return `${window.location.origin}${API_URL}`;
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
