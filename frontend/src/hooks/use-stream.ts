import { useState, useRef, useCallback } from 'react';
import {
  requestStreamCookie,
  requestGuestStreamCookie,
  clearStreamCookie,
  handleBandwidthError,
} from '@/lib/api';
import { useI18n } from '@/components/i18n-context';
import toast from 'react-hot-toast';

interface UseStreamOptions {
  cookieFn?: () => Promise<{ ttl: number }>;
}

interface UseStreamResult {
  streamUrl: string | null;
  isLoading: boolean;
  setupStream: (streamUrl: string) => Promise<void>;
  teardownStream: () => void;
}

function waitForCookieCommit(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

/**
 * Shared hook quản lý stream cookie lifecycle.
 *
 * Tự động request cookie, refresh ở 80% TTL, và cleanup khi unmount.
 * Không thử Fallback — nếu get cookie thất bại, streamUrl sẽ null.
 *
 * @param options.cookieFn — Hàm request cookie. Mặc định: dùng auth-aware (user优先).
 */
export function useStream(options?: UseStreamOptions): UseStreamResult {
  const { t } = useI18n();
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const scheduleRefresh = useCallback((ttlMs: number, url: string) => {
    clearTimer();
    refreshTimerRef.current = setTimeout(async function refresh() {
      try {
        const cookieRes = await (options?.cookieFn ?? requestStreamCookie)();
        scheduleRefresh(cookieRes.ttl * 800, url);
      } catch {
        // Cookie refresh failed — stream will break on next use
      }
    }, ttlMs);
  }, [options?.cookieFn, clearTimer]);

  const setupStream = useCallback(async (url: string) => {
    setIsLoading(true);
    try {
      const cookieFn = options?.cookieFn ?? requestStreamCookie;
      const cookieRes = await cookieFn();
      await waitForCookieCommit();
      setStreamUrl(url);
      scheduleRefresh(cookieRes.ttl * 800, url);
    } catch (err: unknown) {
      const info = handleBandwidthError(err);
      if (info) {
        toast.error(t('dashboard.bandwidthExceededAt', { time: info.resetTime }));
      }
      setStreamUrl(null);
    } finally {
      setIsLoading(false);
    }
  }, [options?.cookieFn, scheduleRefresh]);

  const teardownStream = useCallback(() => {
    clearTimer();
    setStreamUrl(null);
    clearStreamCookie().catch(() => {});
  }, [clearTimer]);

  return { streamUrl, isLoading, setupStream, teardownStream };
}

/**
 * Hook stream cho public share pages — luôn dùng guest cookie.
 */
export function useGuestStream(): UseStreamResult {
  return useStream({ cookieFn: requestGuestStreamCookie });
}
