'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';

export interface ActionItem { id: string; type: 'file' | 'folder' }
type Translate = (key: string, vars?: Record<string, string>) => string;

/** One mutation at a time, including rapid clicks before React has rendered. */
export function useItemActions(
  t: Translate,
  refresh: () => void | Promise<void>,
  removeItems: (ids: string[]) => void,
) {
  const lock = useRef(false);
  const callbacks = useRef({ refresh, removeItems });
  useEffect(() => { callbacks.current = { refresh, removeItems }; }, [refresh, removeItems]);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const run = useCallback(async (
    items: ActionItem[],
    action: (item: ActionItem) => Promise<unknown>,
  ) => {
    if (lock.current || !items.length) return null;
    lock.current = true;
    const completedIds: string[] = [];
    const failedIds: string[] = [];
    setPendingIds(new Set(items.map(item => item.id)));
    setProgress({ done: 0, total: items.length });
    const message = (done: number) => t('actions.progress', { done: String(done), total: String(items.length) });
    const toastId = toast.loading(message(0));
    try {
      for (const item of items) {
        try {
          await action(item);
          completedIds.push(item.id);
          callbacks.current.removeItems([item.id]);
        } catch {
          failedIds.push(item.id);
        }
        const done = completedIds.length + failedIds.length;
        setProgress({ done, total: items.length });
        toast.loading(message(done), { id: toastId });
      }
      const summary = t(failedIds.length ? 'actions.partialFailure' : 'actions.complete', {
        success: String(completedIds.length), failed: String(failedIds.length),
      });
      if (failedIds.length) toast.error(summary, { id: toastId });
      else toast.success(summary, { id: toastId });
      // Keep loaded pages and failed rows available for retry after partial failure.
      if (!failedIds.length) {
        try { await callbacks.current.refresh(); }
        catch { toast.error(t('actions.refreshFailed')); }
      }
      return { failedIds, completedIds, toastId };
    } finally {
      lock.current = false;
      setPendingIds(new Set());
      setProgress(null);
    }
  }, [t]);

  return { run, pendingIds, progress, isBusy: progress !== null };
}
