import { useEffect, useRef } from 'react';
import { api } from '../lib/api';

export function useBufferSync(
  files: Array<{ id: string; status: string }>,
  onStatusChange: (id: string, newStatus: string) => void,
) {
  const onStatusChangeRef = useRef(onStatusChange);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const bufferedIds = files
    .filter((f) => f.status === 'buffered')
    .map((f) => f.id);

  const bufferedIdsKey = bufferedIds.sort().join(',');

  useEffect(() => {
    if (bufferedIds.length === 0) return;

    const poll = async () => {
      try {
        // Chunk IDs to max 50 items per request (server limit)
        const chunk = bufferedIds.slice(0, 50);
        const res = await api.get('/transfer/buffer-status', {
          params: { ids: chunk.join(',') },
        });

        // The response format: array of { id: string, status: string }
        const statusList = res.data as Array<{ id: string; status: string }>;
        for (const item of statusList) {
          const original = files.find((f) => f.id === item.id);
          if (original && original.status !== item.status) {
            onStatusChangeRef.current(item.id, item.status);
          }
        }
      } catch (err) {
        console.error('Failed to sync buffer status:', err);
      }
    };

    // Run immediately, then every 5 seconds
    poll();
    const interval = setInterval(poll, 5000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bufferedIdsKey]);
}
