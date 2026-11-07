'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';

import { api, transferApi, fetchCurrentUser, clearStreamCookie } from '@/lib/api';

interface User {
  id: string;
  username: string;
  email?: string | null;
  role: string;
}

function isStoredUser(value: unknown): value is User {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<User>;
  return typeof candidate.id === 'string'
    && typeof candidate.username === 'string'
    && typeof candidate.role === 'string'
    && (candidate.email === undefined
      || candidate.email === null
      || typeof candidate.email === 'string');
}

function clearStoredAuth() {
  try {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  } catch {
    // Storage can be unavailable under browser privacy policies.
  }
  clearAuthHeader();
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
  refreshUser: (skipRequestOverlay?: boolean) => Promise<void>;
  refreshQuota: (skipRequestOverlay?: boolean) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// JWT header helpers — áp cho CẢ `api` (control) và `transferApi` (data) để
// data-plane XHR không bị 401. DRY: một chỗ set/clear, hai instance.
const AUTH_INSTANCES = [api, transferApi];

function setAuthHeader(accessToken: string) {
  for (const instance of AUTH_INSTANCES) {
    instance.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
  }
}

function clearAuthHeader() {
  for (const instance of AUTH_INSTANCES) {
    delete instance.defaults.headers.common['Authorization'];
  }
}

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
  const requestInterceptorIds = useRef<number[]>([]);
  const responseInterceptorIds = useRef<number[]>([]);

  const refreshUser = useCallback(async (skipRequestOverlay = false) => {
    const currentToken = localStorage.getItem('token');
    if (!currentToken) return;

    const data = await fetchCurrentUser(skipRequestOverlay);
    const nextUser = {
      id: data.id,
      username: data.username,
      email: data.email,
      role: data.role,
    };
    localStorage.setItem('user', JSON.stringify(nextUser));
    setUser(nextUser);
    setQuotaInfo({
      usedSpace: Number(data.usedSpace),
      quota: Number(data.quota),
    });
  }, []);

  // Fetch quota từ server — gọi 1 lần khi có token, sau đó gọi lại qua refreshQuota
  const refreshQuota = useCallback(async (skipRequestOverlay = false) => {
    try {
      await refreshUser(skipRequestOverlay);
    } catch {
      // non-critical
    }
  }, [refreshUser]);

  // Khởi tạo: đọc token từ localStorage VÀ set axios header ngay lập tức
  useEffect(() => {
    let savedToken: string | null = null;
    let savedUser: string | null = null;
    try {
      savedToken = localStorage.getItem('token');
      savedUser = localStorage.getItem('user');
      if (!savedToken && !savedUser) return;
      if (!savedToken || !savedUser) {
        clearStoredAuth();
        return;
      }

      const parsedUser: unknown = JSON.parse(savedUser);
      if (!isStoredUser(parsedUser)) {
        clearStoredAuth();
        return;
      }

      setAuthHeader(savedToken);
      setToken(savedToken);
      setUser(parsedUser);
    } catch {
      clearStoredAuth();
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch quota 1 lần khi đã có token
  useEffect(() => {
    if (token) {
      refreshQuota();
    }
  }, [token, refreshQuota]);

  // Axios request interceptor: mọi request tự lấy token mới nhất từ localStorage.
  // Đây là safety net — nếu axios.defaults bị miss do timing, interceptor sẽ bắt lại.
  // Gắn cho CẢ `api` và `transferApi` để data-plane XHR cũng mang JWT.
  useEffect(() => {
    requestInterceptorIds.current = AUTH_INSTANCES.map((instance) =>
      instance.interceptors.request.use((config) => {
        const currentToken = localStorage.getItem('token');
        if (currentToken) {
          config.headers.Authorization = `Bearer ${currentToken}`;
        } else {
          delete config.headers.Authorization;
        }
        return config;
      }),
    );

    return () => {
      AUTH_INSTANCES.forEach((instance, i) => {
        instance.interceptors.request.eject(requestInterceptorIds.current[i]);
      });
    };
  }, []);

  // Axios response interceptor: tự động xử lí 401 — clear auth state + redirect login.
  // Tập trung logic ở đây thay vì lặp try/catch 401 ở từng page.
  useEffect(() => {
    responseInterceptorIds.current = AUTH_INSTANCES.map((instance) =>
      instance.interceptors.response.use(
        (response) => response,
        (error) => {
          const url = error.config?.url || '';
          const isAuthRoute = url.includes('/auth/login') || url.includes('/auth/register');

          if (error?.response?.status === 401 && !isAuthRoute) {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            clearAuthHeader();
            setToken(null);
            setUser(null);
            setQuotaInfo(null);

            if (window.location.pathname !== '/login') {
              window.location.href = '/login';
            }
          }
          return Promise.reject(error);
        },
      ),
    );

    return () => {
      AUTH_INSTANCES.forEach((instance, i) => {
        instance.interceptors.response.eject(responseInterceptorIds.current[i]);
      });
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.post(`/auth/login`, { username, password });
    const { access_token, user: userData } = res.data;
    localStorage.setItem('token', access_token);
    localStorage.setItem('user', JSON.stringify(userData));
    setAuthHeader(access_token);
    setToken(access_token);
    setUser(userData);
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const res = await api.post(`/auth/register`, { username, password });
    const { access_token, user: userData } = res.data;
    localStorage.setItem('token', access_token);
    localStorage.setItem('user', JSON.stringify(userData));
    setAuthHeader(access_token);
    setToken(access_token);
    setUser(userData);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setQuotaInfo(null);
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    clearAuthHeader();
    // Huỷ stream cookie ở đây (không ở teardownStream) — đây là lúc đúng để
    // vô hiệu token stream dùng chung toàn domain.
    clearStreamCookie().catch(() => {});
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, quotaInfo, login, register, logout, refreshUser, refreshQuota }}>
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
