'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import axios from 'axios';
import { api, abortUpload, createFolderBatch } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { useAppSelector } from '@/lib/store';
import { loadUploadConfig } from '@/lib/upload-config-slice';
import { useAppDispatch } from '@/lib/store';

export type ConflictResolution = 'overwrite' | 'keepBoth' | 'merge' | 'skip';

export interface QueueItem {
  id: string;
  file: File;
  targetFolderId?: string;
  relativePath?: string;
  status: 'pending' | 'uploading' | 'complete' | 'error' | 'cancelled';
  progress: number;
  uploadedBytes: number;
  totalBytes: number;
  completedChunks: number;
  totalChunks: number;
  errorMessage?: string;
  serverFileId?: string;
  conflictInfo?: { type: 'file' | 'folder'; name: string; existingItemId: string };
  conflictAction?: 'overwrite' | 'rename';
}

interface UploadContextValue {
  queue: QueueItem[];
  isUploading: boolean;
  addFiles: (files: FileList | File[], folderId?: string) => void;
  addFolder: (files: FileList | File[], folderId?: string) => Promise<void>;
  cancelItem: (id: string) => void;
  cancelAll: () => void;
  clearCompleted: () => void;
  retryItem: (id: string) => void;
  resolveConflict: (id: string, action: ConflictResolution) => Promise<void>;
  currentFolderId?: string;
  setCurrentFolderId: (id?: string) => void;
  onUploadSuccess?: () => void;
  setOnUploadSuccess: (cb: (() => void) | undefined) => void;
  setOnConflict: (cb: ((queueItem: QueueItem) => Promise<ConflictResolution>) | undefined) => void;
}

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
    if (!loaded) {
      dispatch(loadUploadConfig());
    }
  }, [dispatch, loaded]);

  // beforeunload handler
  const isUploading = queue.some(item => item.status === 'uploading' || item.status === 'pending');

  useEffect(() => {
    if (!isUploading) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isUploading]);

  // Update a queue item by id
  const updateItem = useCallback((id: string, updates: Partial<QueueItem>) => {
    setQueue(prev => prev.map(item => item.id === id ? { ...item, ...updates } : item));
  }, []);

  // Upload a single small file
  const uploadSimple = useCallback(async (item: QueueItem) => {
    const abortController = new AbortController();
    abortControllersRef.current.set(item.id, [abortController]);

    const formData = new FormData();
    formData.append('file', item.file);
    if (item.targetFolderId) formData.append('folderId', item.targetFolderId);

    const url = item.conflictAction
      ? `/files/upload?onConflict=${item.conflictAction}`
      : `/files/upload`;

    await api.post(url, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      signal: abortController.signal,
      onUploadProgress: (progressEvent) => {
        const uploaded = progressEvent.loaded || 0;
        updateItem(item.id, {
          uploadedBytes: uploaded,
          progress: Math.round((uploaded / item.totalBytes) * 100),
        });
      },
    });
  }, [updateItem]);

  // Upload a large file in chunks
  const uploadChunked = useCallback(async (item: QueueItem) => {
    const totalChunks = Math.ceil(item.file.size / maxChunkSize);
    updateItem(item.id, { totalChunks });

    const initUrl = item.conflictAction
      ? `/files/upload/init?onConflict=${item.conflictAction}`
      : `/files/upload/init`;

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

      const MAX_429_RETRIES = 5;
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
          break; // success
        } catch (err: unknown) {
          if (
            axios.isAxiosError(err) &&
            err.response?.status === 429 &&
            attempt < MAX_429_RETRIES &&
            !abortController.signal.aborted
          ) {
            const retryAfter = err.response?.data?.retryAfter || 5;
            chunkProgress[chunkIndex] = 0;
            updateProgress();
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            continue;
          }
          throw err;
        }
      }

      chunkProgress[chunkIndex] = chunkSizes[chunkIndex];
      completedCount++;
      updateProgress();
    };

    let workerError: Error | null = null;

    const abortAllControllers = () => {
      controllers.forEach(ctrl => ctrl.abort());
    };

    const worker = async () => {
      while (chunkQueue.length > 0) {
        if (workerError) return; // Another worker failed — stop picking new chunks
        const currentItem = queueRef.current.find(q => q.id === item.id);
        if (!currentItem || currentItem.status === 'cancelled' || currentItem.status === 'error') return;

        const chunkIndex = chunkQueue.shift();
        if (chunkIndex === undefined) return;
        try {
          await uploadSingleChunk(chunkIndex);
        } catch (err) {
          if (!workerError) workerError = err as Error; // Preserve the FIRST error (not CanceledError from abort)
          abortAllControllers();
          throw err;
        }
      }
    };

    const workers = Array(Math.min(concurrency, totalChunks))
      .fill(null)
      .map(() => worker());
    await Promise.allSettled(workers);

    // If any worker failed, propagate the first error
    if (workerError) {
      throw workerError;
    }

    const currentItem = queueRef.current.find(q => q.id === item.id);
    if (!currentItem || currentItem.status === 'cancelled') {
      throw new Error('Upload cancelled');
    }

    await api.post(`/files/upload/${serverFileId}/complete`);
  }, [maxChunkSize, concurrency, updateItem]);

  // Process queue — pick next pending item and upload
  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;

    const processItem = async (item: QueueItem) => {
      updateItem(item.id, { status: 'uploading' });

      try {
        if (item.file.size <= maxChunkSize) {
          await uploadSimple(item);
        } else {
          await uploadChunked(item);
        }

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
          updateItem(item.id, {
            status: 'error',
            errorMessage,
          });
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
          const batch = smallFiles.slice(0, 5);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxChunkSize, uploadSimple, uploadChunked, updateItem, refreshQuota]);

  // Auto-process queue when items are added
  useEffect(() => {
    const hasPending = queue.some(item => item.status === 'pending');
    const hasUploading = queue.some(item => item.status === 'uploading');
    if (hasPending && !hasUploading && !processingRef.current) {
      processQueue();
    }
  }, [queue, processQueue]);

  // Add files to queue
  const addFiles = useCallback((files: FileList | File[], folderId?: string) => {
    const fileArray = Array.from(files);
    const newItems: QueueItem[] = fileArray.map(file => ({
      id: uid(),
      file,
      targetFolderId: folderId,
      status: 'pending' as const,
      progress: 0,
      uploadedBytes: 0,
      totalBytes: file.size,
      completedChunks: 0,
      totalChunks: 1,
    }));
    setQueue(prev => [...prev, ...newItems]);
  }, []);

  // Add folder — read file list, create subfolders, add files
  const addFolder = useCallback(async (fileList: FileList | File[], folderId?: string) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    // Group files by directory path
    const dirSet = new Set<string>();
    for (const file of files) {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      if (!relativePath) continue;
      const parts = relativePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirSet.add(parts.slice(0, i).join('/'));
      }
    }

    const dirs = Array.from(dirSet);

    // Create folders on backend and cache folderId mapping
    const folderMap = new Map<string, string>();

    if (dirs.length > 0) {
      try {
        const batchResult = await createFolderBatch(dirs, folderId);
        Object.entries(batchResult).forEach(([path, id]) => {
          folderMap.set(path, id);
        });
      } catch (error: unknown) {
        const msg = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : String(error);
        console.warn('Failed to create folders in batch:', msg);
      }
    }

    // Add files to queue with correct targetFolderId
    const newItems: QueueItem[] = files.map(file => {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      const parts = relativePath ? relativePath.split('/') : [file.name];
      const dirPath = parts.slice(0, -1).join('/');
      const targetId = dirPath ? folderMap.get(dirPath) : folderId;

      return {
        id: uid(),
        file,
        targetFolderId: targetId || folderId,
        relativePath,
        status: 'pending' as const,
        progress: 0,
        uploadedBytes: 0,
        totalBytes: file.size,
        completedChunks: 0,
        totalChunks: 1,
      };
    });

    setQueue(prev => [...prev, ...newItems]);
  }, []);

  // Cancel single item
  const cancelItem = useCallback((id: string) => {
    const item = queueRef.current.find(q => q.id === id);
    if (!item) return;

    if (item.status === 'uploading') {
      const controllers = abortControllersRef.current.get(id);
      controllers?.forEach(ctrl => ctrl.abort());

      if (item.serverFileId) {
        abortUpload(item.serverFileId).catch(() => { });
      }
    }

    updateItem(id, { status: 'cancelled' });
  }, [updateItem]);

  // Cancel all
  const cancelAll = useCallback(() => {
    for (const item of queueRef.current) {
      if (item.status === 'pending' || item.status === 'uploading') {
        cancelItem(item.id);
      }
    }
  }, [cancelItem]);

  // Clear completed/cancelled/error items
  const clearCompleted = useCallback(() => {
    setQueue(prev => prev.filter(item =>
      item.status === 'pending' || item.status === 'uploading'
    ));
  }, []);

  // Retry failed item
  const retryItem = useCallback((id: string) => {
    updateItem(id, {
      status: 'pending',
      progress: 0,
      uploadedBytes: 0,
      completedChunks: 0,
      errorMessage: undefined,
      serverFileId: undefined,
      conflictInfo: undefined,
    });
  }, [updateItem]);

  // Resolve conflict by re-trying upload with chosen action
  const resolveConflict = useCallback(async (id: string, action: ConflictResolution) => {
    if (action === 'skip') {
      updateItem(id, { status: 'cancelled', errorMessage: 'Skipped (conflict)' });
      return;
    }

    // Merge is only for folders — uploads are files, so treat merge as keepBoth (rename)
    const backendAction = action === 'merge' ? 'rename' : action === 'keepBoth' ? 'rename' : 'overwrite';

    updateItem(id, {
      status: 'pending',
      progress: 0,
      uploadedBytes: 0,
      completedChunks: 0,
      errorMessage: undefined,
      serverFileId: undefined,
      conflictInfo: undefined,
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
      queue,
      isUploading,
      addFiles,
      addFolder,
      cancelItem,
      cancelAll,
      clearCompleted,
      retryItem,
      currentFolderId,
      setCurrentFolderId,
      setOnUploadSuccess,
      setOnConflict,
      resolveConflict,
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
