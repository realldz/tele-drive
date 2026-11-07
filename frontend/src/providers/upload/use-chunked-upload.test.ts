import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { useChunkedUpload } from '@/providers/upload/use-chunked-upload';
import type { QueueItem } from '@/providers/upload/upload-types';

vi.mock('@/lib/api', () => ({ api: { post: vi.fn() } }));
vi.mock('@/providers/upload/upload-request-pacer', () => ({
  acquireUploadSlot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/providers/upload/upload-conflict-gate', () => ({
  runGatedInit: vi.fn((request: () => Promise<unknown>) => request()),
  pauseInitForConflict: vi.fn(),
}));

describe('useChunkedUpload', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps the upload pipeline out of the global request overlay', async () => {
    const item: QueueItem = {
      id: 'queue-id',
      file: new File(['content'], 'example.txt', { type: 'text/plain' }),
      status: 'uploading',
      progress: 0,
      uploadedBytes: 0,
      totalBytes: 7,
      completedChunks: 0,
      totalChunks: 1,
    };
    vi.mocked(api.post).mockImplementation(async (url) => (
      url === '/transfer/upload/init' ? { data: { id: 'server-id' } } : { data: {} }
    ));

    const { result } = renderHook(() => useChunkedUpload({
      maxChunkSize: 1024,
      concurrency: 1,
      updateItem: vi.fn(),
      queueRef: { current: [item] },
      abortControllersRef: { current: new Map() },
    }));

    await act(async () => result.current(item));

    expect(api.post).toHaveBeenNthCalledWith(
      1,
      '/transfer/upload/init',
      expect.any(Object),
      expect.objectContaining({ skipRequestOverlay: true }),
    );
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      '/transfer/upload/server-id/chunk/0',
      expect.any(Blob),
      expect.objectContaining({ skipRequestOverlay: true }),
    );
    expect(api.post).toHaveBeenNthCalledWith(
      3,
      '/transfer/upload/server-id/complete',
      undefined,
      expect.objectContaining({ skipRequestOverlay: true }),
    );
  });
});
