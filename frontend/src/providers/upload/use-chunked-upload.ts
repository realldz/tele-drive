'use client';

import { useCallback } from 'react';
import axios from 'axios';
import { api } from '@/lib/api';
import {
  UPLOAD_MAX_CHUNK_RETRIES,
  UPLOAD_RETRY_AFTER_429_S,
  UPLOAD_RETRY_AFTER_503_S,
} from '@/lib/constants';
import type { QueueItem } from './upload-types';

interface UseChunkedUploadArgs {
  maxChunkSize: number;
  concurrency: number;
  updateItem: (id: string, updates: Partial<QueueItem>) => void;
  queueRef: React.MutableRefObject<QueueItem[]>;
  abortControllersRef: React.MutableRefObject<Map<string, AbortController[]>>;
}

/**
 * Chunked upload engine: init → parallel chunk upload (with per-chunk retry on
 * 429/503) → complete. All binary data is ingested by the Go transfer service;
 * small files resolve to a single chunk.
 */
export function useChunkedUpload({
  maxChunkSize, concurrency, updateItem, queueRef, abortControllersRef,
}: UseChunkedUploadArgs) {
  return useCallback(async (item: QueueItem) => {
    const totalChunks = Math.ceil(item.file.size / maxChunkSize);
    updateItem(item.id, { totalChunks });

    const initUrl = item.conflictAction
      ? `/transfer/upload/init?onConflict=${item.conflictAction}`
      : `/transfer/upload/init`;

    const initRes = await api.post(initUrl, {
      filename: item.file.name,
      size: item.file.size,
      mimeType: item.file.type || 'application/octet-stream',
      totalChunks,
      folderId: item.targetFolderId || undefined,
    });

    const serverFileId = initRes.data.id;
    updateItem(item.id, { serverFileId });

    const chunkProgress: number[] = new Array(totalChunks).fill(0);
    const chunkSizes: number[] = [];
    let completedCount = 0;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * maxChunkSize;
      const end = Math.min(start + maxChunkSize, item.file.size);
      chunkSizes.push(end - start);
    }

    const chunkQueue = Array.from({ length: totalChunks }, (_, i) => i);
    const controllers: AbortController[] = [];
    abortControllersRef.current.set(item.id, controllers);

    const updateProgress = () => {
      const totalUploaded = chunkProgress.reduce((a, b) => a + b, 0);
      updateItem(item.id, {
        uploadedBytes: Math.min(totalUploaded, item.file.size),
        progress: Math.round((Math.min(totalUploaded, item.file.size) / item.file.size) * 100),
        completedChunks: completedCount,
      });
    };

    const uploadSingleChunk = async (chunkIndex: number) => {
      const start = chunkIndex * maxChunkSize;
      const end = Math.min(start + maxChunkSize, item.file.size);
      const chunkBlob = item.file.slice(start, end);

      const abortController = new AbortController();
      controllers.push(abortController);

      for (let attempt = 0; ; attempt++) {
        try {
          await api.post(
            `/transfer/upload/${serverFileId}/chunk/${chunkIndex}`,
            chunkBlob,
            {
              timeout: 0,
              headers: { 'Content-Type': 'application/octet-stream' },
              signal: abortController.signal,
              onUploadProgress: (progressEvent) => {
                chunkProgress[chunkIndex] = progressEvent.loaded || 0;
                updateProgress();
              },
            },
          );
          break;
        } catch (err: unknown) {
          if (axios.isAxiosError(err) && !abortController.signal.aborted) {
            const status = err.response?.status;
            const retryable = status === 429 || (status === 503 && err.response?.data?.error === 'upload_buffer_full');
            if (retryable && attempt < UPLOAD_MAX_CHUNK_RETRIES) {
              const retryAfter = err.response?.data?.retryAfter
                || (status === 429 ? UPLOAD_RETRY_AFTER_429_S : UPLOAD_RETRY_AFTER_503_S);
              chunkProgress[chunkIndex] = 0;
              updateProgress();
              await new Promise(r => setTimeout(r, retryAfter * 1000));
              continue;
            }
          }
          throw err;
        }
      }

      chunkProgress[chunkIndex] = chunkSizes[chunkIndex];
      completedCount++;
      updateProgress();
    };

    let workerError: Error | null = null;
    const abortAllControllers = () => controllers.forEach(ctrl => ctrl.abort());

    const worker = async () => {
      while (chunkQueue.length > 0) {
        if (workerError) return;
        const currentItem = queueRef.current.find(q => q.id === item.id);
        if (!currentItem || currentItem.status === 'cancelled' || currentItem.status === 'error') return;

        const chunkIndex = chunkQueue.shift();
        if (chunkIndex === undefined) return;
        try {
          await uploadSingleChunk(chunkIndex);
        } catch (err) {
          if (!workerError) workerError = err as Error;
          abortAllControllers();
          throw err;
        }
      }
    };

    const workers = Array(Math.min(concurrency, totalChunks)).fill(null).map(() => worker());
    await Promise.allSettled(workers);

    if (workerError) throw workerError;

    const currentItem = queueRef.current.find(q => q.id === item.id);
    if (!currentItem || currentItem.status === 'cancelled') {
      throw new Error('Upload cancelled');
    }

    await api.post(`/transfer/upload/${serverFileId}/complete`);
  }, [maxChunkSize, concurrency, updateItem, queueRef, abortControllersRef]);
}
