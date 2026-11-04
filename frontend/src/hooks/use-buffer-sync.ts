import { useEffect, useRef } from 'react';
import { transferApi } from '@/lib/api';

export function useBufferSync(
  files: Array<{ id: string; status: string }>,
  onStatusChange: (id: string, newStatus: string) => void,
) {
  const onStatusChangeRef = useRef(onStatusChange);
  const nextChunkRef = useRef(0);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const bufferedIds = files
    .filter((f) => f.status === 'buffered')
    .map((f) => f.id);

  const bufferedIdsKey = bufferedIds.sort().join(',');

  useEffect(() => {
    if (bufferedIds.length === 0) return;
    nextChunkRef.current = 0;
    let inFlight = false;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        // Rotate through all buffered IDs without exceeding the server limit.
        const chunkCount = Math.ceil(bufferedIds.length / 50);
        const chunkIndex = nextChunkRef.current % chunkCount;
        nextChunkRef.current = (chunkIndex + 1) % chunkCount;
        const chunk = bufferedIds.slice(chunkIndex * 50, (chunkIndex + 1) * 50);
        const res = await transferApi.get('/transfer/buffer-status', {
          params: { ids: chunk.join(',') },
          skipRequestOverlay: true,
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
      } finally {
        inFlight = false;
      }
    };

    // Run immediately, then every 5 seconds
    poll();
    const interval = setInterval(poll, 5000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bufferedIdsKey]);
}
