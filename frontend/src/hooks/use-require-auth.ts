'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-context';

interface UseRequireAuthOptions {
  requiredRole?: string;
}

/**
 * Hook bảo vệ trang cần đăng nhập.
 * - Redirect về /login nếu chưa có token.
 * - Redirect về / nếu không đủ role (khi truyền requiredRole).
 * - Trả về isReady = true khi đã xác thực xong, page an toàn để render.
 */
export function useRequireAuth(options?: UseRequireAuthOptions) {
  const { user, token, isLoading, logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    if (!token) {
      router.push('/login');
      return;
    }
    if (options?.requiredRole && user?.role !== options.requiredRole) {
      router.push('/');
    }
  }, [isLoading, token, user, router, options?.requiredRole]);

  const isReady =
    !isLoading &&
    !!token &&
    (!options?.requiredRole || user?.role === options.requiredRole);

  return { isReady, user, token, logout };
}
