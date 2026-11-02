'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { getCleanupStatus, startCleanup, type TrashCleanupStatus } from '@/lib/api';
import { TRASH_CLEANUP_POLL_MS } from '@/lib/constants';

export function useTrashCleanup(
  token: string | null,
  t: (key: string, vars?: Record<string, string>) => string,
  refresh: () => Promise<void>,
) {
  const [status, setStatus] = useState<TrashCleanupStatus>({ isCleaning: false });
  const [starting, setStarting] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const [checking, setChecking] = useState(true);
  const [pollVersion, setPollVersion] = useState(0);
  const startLock = useRef(false);
  const wasCleaning = useRef(false);

  useEffect(() => {
    if (!token) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let retry = true;
      try {
        const next = await getCleanupStatus();
        if (disposed) return;
        retry = next.isCleaning;
        setChecking(false);
        setStatusError(false);
        setStatus(next);
        if (wasCleaning.current && !next.isCleaning) {
          await refresh();
          if (disposed) return;
          toast(next.totalCount ? t('trash.cleanupRemaining') : t('trash.cleanupComplete', {
            count: String(next.deletedCount ?? 0),
          }));
        }
        wasCleaning.current = next.isCleaning;
      } catch {
        if (!disposed) setStatusError(true);
        // Keep the last known state and retry; a failed poll does not mean completion.
      } finally {
        if (!disposed && retry) timer = setTimeout(poll, TRASH_CLEANUP_POLL_MS);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [token, pollVersion, refresh, t]);

  const start = useCallback(async () => {
    if (startLock.current || checking || status.isCleaning) return;
    if (!confirm(t('trash.emptyTrashConfirm'))) return;
    startLock.current = true;
    setStarting(true);
    try {
      const result = await startCleanup();
      wasCleaning.current = result.accepted;
      setStatus({ isCleaning: result.accepted });
      if (result.accepted) toast.success(t('trash.cleanupStarted'));
      else await refresh();
      setPollVersion(version => version + 1);
    } catch {
      // A timed-out POST may already have started cleanup on the server.
      setChecking(true);
      toast.error(t('actions.requestFailed'));
      setPollVersion(version => version + 1);
    } finally {
      startLock.current = false;
      setStarting(false);
    }
  }, [checking, status.isCleaning, t, refresh]);

  return { cleanupStatus: status, isEmptying: starting || checking, statusError,
    retryStatus: () => setPollVersion(version => version + 1), start };
}
