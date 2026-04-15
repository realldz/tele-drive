import { useState, useCallback } from 'react';

/**
 * Hook for per-item loading states.
 * Tracks which items are currently being processed (delete, download, etc.)
 * so each button can show its own inline spinner independently.
 *
 * Usage:
 *   const { loading, withLoading, isDone } = useItemLoading();
 *   <Button disabled={loading.has(file.id)} onClick={() => withLoading(file.id, () => handleDelete(file.id))}>
 *     {loading.has(file.id) ? <Loader2 /> : <Trash2 />}
 *   </Button>
 *   {isDone.has(file.id) && <span class="text-green-500">Done</span>}
 */
export function useItemLoading() {
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());

  const withLoading = useCallback(async (id: string, fn: () => Promise<void>) => {
    setLoading(prev => new Set(prev).add(id));
    try {
      await fn();
      setDone(prev => new Set(prev).add(id));
    } finally {
      setLoading(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const clearDone = useCallback((id?: string) => {
    if (id) {
      setDone(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } else {
      setDone(new Set());
    }
  }, []);

  return { loading, isDone: done, withLoading, clearDone };
}
