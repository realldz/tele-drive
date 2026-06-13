'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import axios from 'axios';
import { abortUpload, createFolderBatch } from '@/lib/api';
import { useAuth } from '@/providers/auth-context';
import { useAppSelector, useAppDispatch } from '@/lib/store';
import { loadUploadConfig } from '@/lib/upload-config-slice';
import { UPLOAD_SMALL_FILE_BATCH } from '@/lib/constants';
import { useChunkedUpload } from './use-chunked-upload';
import type { ConflictResolution, QueueItem, UploadContextValue } from './upload-types';

const UploadContext = createContext<UploadContextValue | undefined>(undefined);

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const { refreshQuota } = useAuth();
  const dispatch = useAppDispatch();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const { maxChunkSize, maxConcurrentChunks: concurrency, loaded } = useAppSelector(state => state.uploadConfig);
  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>();

  const abortControllersRef = useRef<Map<string, AbortController[]>>(new Map());
  const processingRef = useRef(false);
  const onUploadSuccessRef = useRef<(() => void) | undefined>(undefined);
  const onConflictRef = useRef<((queueItem: QueueItem) => Promise<ConflictResolution>) | undefined>(undefined);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  useEffect(() => {
    if (!loaded) dispatch(loadUploadConfig());
  }, [dispatch, loaded]);

  const isUploading = queue.some(item => item.status === 'uploading' || item.status === 'pending');

  useEffect(() => {
    if (!isUploading) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isUploading]);

  const updateItem = useCallback((id: string, updates: Partial<QueueItem>) => {
    setQueue(prev => prev.map(item => item.id === id ? { ...item, ...updates } : item));
  }, []);

  const uploadChunked = useChunkedUpload({
    maxChunkSize, concurrency, updateItem, queueRef, abortControllersRef,
  });

  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;

    const processItem = async (item: QueueItem) => {
      updateItem(item.id, { status: 'uploading' });
      try {
        await uploadChunked(item);
        const currentItem = queueRef.current.find(q => q.id === item.id);
        if (currentItem && currentItem.status !== 'cancelled') {
          updateItem(item.id, { status: 'complete', progress: 100 });
          onUploadSuccessRef.current?.();
          refreshQuota();
        }
      } catch (error: unknown) {
        if (axios.isCancel(error) || (error instanceof Error && error.message === 'Upload cancelled')) {
          // Already handled by cancelItem
        } else if (axios.isAxiosError(error) && error.response?.status === 409) {
          updateItem(item.id, {
            status: 'error',
            errorMessage: 'conflict',
            conflictInfo: {
              type: 'file',
              name: item.file.name,
              existingItemId: error.response.data?.existingItemId || '',
            },
          });
        } else {
          const errorMessage = axios.isAxiosError(error)
            ? error.response?.data?.message || error.message || 'Upload failed'
            : error instanceof Error ? error.message : 'Upload failed';
          updateItem(item.id, { status: 'error', errorMessage });
        }
      } finally {
        abortControllersRef.current.delete(item.id);
      }
    };

    try {
      while (true) {
        const pending = queueRef.current.filter(item => item.status === 'pending');
        if (pending.length === 0) break;

        const smallFiles = pending.filter(i => i.file.size <= maxChunkSize);
        const largeFile = pending.find(i => i.file.size > maxChunkSize);

        if (smallFiles.length > 0) {
          const batch = smallFiles.slice(0, UPLOAD_SMALL_FILE_BATCH);
          await Promise.allSettled(batch.map(item => processItem(item)));
        } else if (largeFile) {
          await processItem(largeFile);
        } else {
          break;
        }
      }
    } finally {
      processingRef.current = false;
    }
  }, [maxChunkSize, uploadChunked, updateItem, refreshQuota]);

  useEffect(() => {
    const hasPending = queue.some(item => item.status === 'pending');
    const hasUploading = queue.some(item => item.status === 'uploading');
    if (hasPending && !hasUploading && !processingRef.current) processQueue();
  }, [queue, processQueue]);

  const addFiles = useCallback((files: FileList | File[], folderId?: string) => {
    const newItems: QueueItem[] = Array.from(files).map(file => ({
      id: uid(), file, targetFolderId: folderId,
      status: 'pending' as const, progress: 0, uploadedBytes: 0,
      totalBytes: file.size, completedChunks: 0, totalChunks: 1,
    }));
    setQueue(prev => [...prev, ...newItems]);
  }, []);

  const addFolder = useCallback(async (fileList: FileList | File[], folderId?: string) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    const dirSet = new Set<string>();
    for (const file of files) {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      if (!relativePath) continue;
      const parts = relativePath.split('/');
      for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join('/'));
    }

    const dirs = Array.from(dirSet);
    const folderMap = new Map<string, string>();

    if (dirs.length > 0) {
      try {
        const batchResult = await createFolderBatch(dirs, folderId);
        Object.entries(batchResult).forEach(([path, id]) => folderMap.set(path, id));
      } catch (error: unknown) {
        const msg = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : String(error);
        console.warn('Failed to create folders in batch:', msg);
      }
    }

    const newItems: QueueItem[] = files.map(file => {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      const parts = relativePath ? relativePath.split('/') : [file.name];
      const dirPath = parts.slice(0, -1).join('/');
      const targetId = dirPath ? folderMap.get(dirPath) : folderId;
      return {
        id: uid(), file, targetFolderId: targetId || folderId, relativePath,
        status: 'pending' as const, progress: 0, uploadedBytes: 0,
        totalBytes: file.size, completedChunks: 0, totalChunks: 1,
      };
    });

    setQueue(prev => [...prev, ...newItems]);
  }, []);

  const cancelItem = useCallback((id: string) => {
    const item = queueRef.current.find(q => q.id === id);
    if (!item) return;
    if (item.status === 'uploading') {
      abortControllersRef.current.get(id)?.forEach(ctrl => ctrl.abort());
      if (item.serverFileId) abortUpload(item.serverFileId).catch(() => { });
    }
    updateItem(id, { status: 'cancelled' });
  }, [updateItem]);

  const cancelAll = useCallback(() => {
    for (const item of queueRef.current) {
      if (item.status === 'pending' || item.status === 'uploading') cancelItem(item.id);
    }
  }, [cancelItem]);

  const clearCompleted = useCallback(() => {
    setQueue(prev => prev.filter(item => item.status === 'pending' || item.status === 'uploading'));
  }, []);

  const retryItem = useCallback((id: string) => {
    updateItem(id, {
      status: 'pending', progress: 0, uploadedBytes: 0, completedChunks: 0,
      errorMessage: undefined, serverFileId: undefined, conflictInfo: undefined,
    });
  }, [updateItem]);

  const resolveConflict = useCallback(async (id: string, action: ConflictResolution) => {
    if (action === 'skip') {
      updateItem(id, { status: 'cancelled', errorMessage: 'Skipped (conflict)' });
      return;
    }
    const backendAction = action === 'merge' ? 'rename' : action === 'keepBoth' ? 'rename' : 'overwrite';
    updateItem(id, {
      status: 'pending', progress: 0, uploadedBytes: 0, completedChunks: 0,
      errorMessage: undefined, serverFileId: undefined, conflictInfo: undefined,
      conflictAction: backendAction,
    });
  }, [updateItem]);

  const setOnConflict = useCallback((cb: ((queueItem: QueueItem) => Promise<ConflictResolution>) | undefined) => {
    onConflictRef.current = cb;
  }, []);

  const setOnUploadSuccess = useCallback((cb: (() => void) | undefined) => {
    onUploadSuccessRef.current = cb;
  }, []);

  return (
    <UploadContext.Provider value={{
      queue, isUploading, addFiles, addFolder, cancelItem, cancelAll,
      clearCompleted, retryItem, currentFolderId, setCurrentFolderId,
      setOnUploadSuccess, setOnConflict, resolveConflict,
    }}>
      {children}
    </UploadContext.Provider>
  );
}

export function useUpload() {
  const context = useContext(UploadContext);
  if (context === undefined) {
    throw new Error('useUpload must be used within an UploadProvider');
  }
  return context;
}
