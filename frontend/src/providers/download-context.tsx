'use client';

import { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react';
import { createDownloadZip, createSharedDownloadZip, getDownloadZipStatus, API_URL } from '@/lib/api';
import type { DownloadZipPart } from '@/lib/api';

export interface DownloadJob {
  jobId: string;
  status: string;
  totalFiles: number;
  processedFiles: number;
  totalSize: string;
  parts: DownloadZipPart[];
  expiresAt: string | null;
  error: string | null;
  label: string;
}

interface DownloadContextValue {
  jobs: DownloadJob[];
  hasActiveJobs: boolean;
  startDownload: (fileIds?: string[], folderIds?: string[], label?: string) => Promise<void>;
  startSharedDownload: (shareToken: string, fileIds?: string[], folderIds?: string[], label?: string) => Promise<void>;
  cancelJob: (jobId: string) => void;
  clearCompleted: () => void;
}

const DownloadContext = createContext<DownloadContextValue | undefined>(undefined);

export function DownloadProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const pollTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const updateJob = useCallback((jobId: string, updates: Partial<DownloadJob>) => {
    setJobs(prev => prev.map(j => j.jobId === jobId ? { ...j, ...updates } : j));
  }, []);

  const startPolling = useCallback((jobId: string) => {
    const timer = setInterval(async () => {
      try {
        const status = await getDownloadZipStatus(jobId);
        updateJob(jobId, status);

        if (['ready', 'failed', 'expired'].includes(status.status)) {
          clearInterval(timer);
          pollTimers.current.delete(jobId);

          // Auto-download if single part
          if (status.status === 'ready' && status.parts.length === 1) {
            const link = document.createElement('a');
            link.href = API_URL + status.parts[0].downloadUrl;
            link.setAttribute('download', '');
            document.body.appendChild(link);
            link.click();
            link.remove();
          }
        }
      } catch {
        // Network error — keep polling
      }
    }, 2000);
    pollTimers.current.set(jobId, timer);
  }, [updateJob]);

  const startDownload = useCallback(async (
    fileIds?: string[], folderIds?: string[], label?: string,
  ) => {
    const { jobId } = await createDownloadZip(fileIds, folderIds);
    const newJob: DownloadJob = {
      jobId,
      status: 'pending',
      totalFiles: 0,
      processedFiles: 0,
      totalSize: '0',
      parts: [],
      expiresAt: null,
      error: null,
      label: label || 'Download',
    };
    setJobs(prev => [...prev, newJob]);
    startPolling(jobId);
  }, [startPolling]);

  const startSharedDownload = useCallback(async (
    shareToken: string, fileIds?: string[], folderIds?: string[], label?: string,
  ) => {
    const { jobId } = await createSharedDownloadZip(shareToken, fileIds, folderIds);
    const newJob: DownloadJob = {
      jobId,
      status: 'pending',
      totalFiles: 0,
      processedFiles: 0,
      totalSize: '0',
      parts: [],
      expiresAt: null,
      error: null,
      label: label || 'Download',
    };
    setJobs(prev => [...prev, newJob]);
    startPolling(jobId);
  }, [startPolling]);

  const cancelJob = useCallback((jobId: string) => {
    const timer = pollTimers.current.get(jobId);
    if (timer) {
      clearInterval(timer);
      pollTimers.current.delete(jobId);
    }
    updateJob(jobId, { status: 'failed', error: 'Cancelled by user' });
  }, [updateJob]);

  const clearCompleted = useCallback(() => {
    setJobs(prev => prev.filter(j => !['ready', 'failed', 'expired'].includes(j.status)));
  }, []);

  const hasActiveJobs = jobs.some(j => ['pending', 'collecting', 'zipping', 'splitting'].includes(j.status));

  return (
    <DownloadContext.Provider value={{ jobs, hasActiveJobs, startDownload, startSharedDownload, cancelJob, clearCompleted }}>
      {children}
    </DownloadContext.Provider>
  );
}

export function useDownload() {
  const ctx = useContext(DownloadContext);
  if (!ctx) throw new Error('useDownload must be used within DownloadProvider');
  return ctx;
}
