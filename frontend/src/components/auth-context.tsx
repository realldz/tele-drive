'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';

import { API_URL, api, fetchCurrentUser } from '@/lib/api';

interface User {
  id: string;
  username: string;
  role: string;
}

interface QuotaInfo {
  usedSpace: number;
  quota: number;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  quotaInfo: QuotaInfo | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
  refreshQuota: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * AuthProvider — quản lý trạng thái đăng nhập, JWT, axios interceptor.
 * Wrap toàn bộ app trong layout.tsx.
 *
 * Sử dụng axios request interceptor để đảm bảo mọi request đều
 * mang đúng JWT header — tránh race condition khi reload trang.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [quotaInfo, setQuotaInfo] = useState<QuotaInfo | null>(null);
  const requestInterceptorId = useRef<number | null>(null);
  const responseInterceptorId = useRef<number | null>(null);

  // Fetch quota từ server — gọi 1 lần khi có token, sau đó gọi lại qua refreshQuota
  const refreshQuota = useCallback(async () => {
    const currentToken = localStorage.getItem('token');
    if (!currentToken) return;
    try {
      const data = await fetchCurrentUser();
      setQuotaInfo({
        usedSpace: Number(data.usedSpace),
        quota: Number(data.quota),
      });
    } catch {
      // non-critical
    }
  }, []);

  // Khởi tạo: đọc token từ localStorage VÀ set axios header ngay lập tức
  useEffect(() => {
    const savedToken = localStorage.getItem('token');
    const savedUser = localStorage.getItem('user');
    if (savedToken && savedUser) {
      api.defaults.headers.common['Authorization'] = `Bearer ${savedToken}`;
      setToken(savedToken);
      setUser(JSON.parse(savedUser));
    }
    setIsLoading(false);
  }, []);

  // Fetch quota 1 lần khi đã có token
  useEffect(() => {
    if (token) {
      refreshQuota();
    }
  }, [token, refreshQuota]);

  // Axios request interceptor: mọi request tự lấy token mới nhất từ localStorage.
  // Đây là safety net — nếu axios.defaults bị miss do timing, interceptor sẽ bắt lại.
  useEffect(() => {
    requestInterceptorId.current = api.interceptors.request.use((config) => {
      const currentToken = localStorage.getItem('token');
      if (currentToken) {
        config.headers.Authorization = `Bearer ${currentToken}`;
      } else {
        delete config.headers.Authorization;
      }
      return config;
    });

    return () => {
      if (requestInterceptorId.current !== null) {
        api.interceptors.request.eject(requestInterceptorId.current);
      }
    };
  }, []);

  // Axios response interceptor: tự động xử lí 401 — clear auth state + redirect login.
  // Tập trung logic ở đây thay vì lặp try/catch 401 ở từng page.
  useEffect(() => {
    responseInterceptorId.current = api.interceptors.response.use(
      (response) => response,
      (error) => {
        const url = error.config?.url || '';
        const isAuthRoute = url.includes('/auth/login') || url.includes('/auth/register');

        if (error?.response?.status === 401 && !isAuthRoute) {
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          delete api.defaults.headers.common['Authorization'];
          setToken(null);
          setUser(null);
          setQuotaInfo(null);

          if (window.location.pathname !== '/login') {
            window.location.href = '/login';
          }
        }
        return Promise.reject(error);
      },
    );

    return () => {
      if (responseInterceptorId.current !== null) {
        api.interceptors.response.eject(responseInterceptorId.current);
      }
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.post(`/auth/login`, { username, password });
    const { access_token, user: userData } = res.data;
    localStorage.setItem('token', access_token);
    localStorage.setItem('user', JSON.stringify(userData));
    api.defaults.headers.common['Authorization'] = `Bearer ${access_token}`;
    setToken(access_token);
    setUser(userData);
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const res = await api.post(`/auth/register`, { username, password });
    const { access_token, user: userData } = res.data;
    localStorage.setItem('token', access_token);
    localStorage.setItem('user', JSON.stringify(userData));
    api.defaults.headers.common['Authorization'] = `Bearer ${access_token}`;
    setToken(access_token);
    setUser(userData);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setQuotaInfo(null);
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    delete api.defaults.headers.common['Authorization'];
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, quotaInfo, login, register, logout, refreshQuota }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
