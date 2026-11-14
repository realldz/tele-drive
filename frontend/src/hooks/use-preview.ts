import { useCallback, useEffect, useRef, useState } from 'react';
import type { SignedPreviewUrl } from '@/lib/api';

type PreviewSource =
  | string
  | Promise<string>
  | (() => Promise<SignedPreviewUrl>);

interface UsePreviewResult {
  previewUrl: string | null;
  isLoading: boolean;
  loadPreview: (source: PreviewSource) => Promise<void>;
  clearPreview: () => void;
}

const REFRESH_RETRY_MS = 30_000;

function getRefreshDelay(preview: SignedPreviewUrl): number {
  const ttlDelay = Number.isFinite(preview.ttl) ? preview.ttl * 800 : Infinity;
  const expiresAt = Date.parse(preview.expiresAt);
  const expiryDelay = Number.isNaN(expiresAt)
    ? Infinity
    : expiresAt - Date.now() - 60_000;
  return Math.max(1_000, Math.min(ttlDelay, expiryDelay));
}

/**
 * Resolves a preview URL without browser cookies or credentialed media
 * requests. The caller owns URL issuance; this hook only handles loading and
 * teardown state shared by the modal and full-page preview surfaces.
 */
export function usePreview(): UsePreviewResult {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const requestIdRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const loadPreview = useCallback(async (source: PreviewSource) => {
    const requestId = ++requestIdRef.current;
    const refreshSource = typeof source === 'function' ? source : null;
    const staticSource = typeof source === 'function' ? null : source;
    clearRefreshTimer();
    setPreviewUrl(null);
    setIsLoading(true);

    const resolvePreview = async (initial: boolean): Promise<void> => {
      try {
        const preview = refreshSource
          ? await refreshSource()
          : { url: await staticSource!, expiresAt: '', ttl: 0 };
        if (requestIdRef.current !== requestId) return;

        setPreviewUrl(preview.url);
        if (refreshSource) {
          refreshTimerRef.current = setTimeout(() => {
            void resolvePreview(false);
          }, getRefreshDelay(preview));
        }
      } catch (error) {
        if (requestIdRef.current !== requestId) return;
        if (initial) throw error;

        // Keep the still-valid URL visible and retry renewal. A transient
        // control-plane failure should not interrupt active playback.
        refreshTimerRef.current = setTimeout(() => {
          void resolvePreview(false);
        }, REFRESH_RETRY_MS);
      } finally {
        if (initial && requestIdRef.current === requestId) {
          setIsLoading(false);
        }
      }
    };

    await resolvePreview(true);
  }, [clearRefreshTimer]);

  const clearPreview = useCallback(() => {
    requestIdRef.current += 1;
    clearRefreshTimer();
    setPreviewUrl(null);
    setIsLoading(false);
  }, [clearRefreshTimer]);

  useEffect(() => () => {
    requestIdRef.current += 1;
    clearRefreshTimer();
  }, [clearRefreshTimer]);

  return { previewUrl, isLoading, loadPreview, clearPreview };
}
