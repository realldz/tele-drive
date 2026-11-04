import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShared } from '@/hooks/use-shared';
import {
  getApiErrorMessage,
  listSharedItems,
  setS3PublicAccess,
  unshareItem,
} from '@/lib/api';
import type { FileRecord, FolderRecord } from '@/lib/types';
import toast from 'react-hot-toast';

vi.mock('@/lib/api', () => ({
  getApiErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
  listSharedItems: vi.fn(),
  setS3PublicAccess: vi.fn(),
  unshareItem: vi.fn(),
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const t = (key: string) => key;
const folder = (overrides: Partial<FolderRecord> = {}): FolderRecord => ({
  id: 'folder-1',
  name: 'Folder',
  parentId: null,
  userId: 'user-1',
  visibility: 'PUBLIC_LINK',
  shareToken: 'folder-token',
  s3PublicAccess: false,
  s3PublicListObjects: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});
const file = (overrides: Partial<FileRecord> = {}): FileRecord => ({
  id: 'file-1',
  filename: 'file.txt',
  size: 1,
  mimeType: 'text/plain',
  status: 'complete',
  totalChunks: 1,
  folderId: null,
  userId: 'user-1',
  visibility: 'PUBLIC_LINK',
  shareToken: 'file-token',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const page = (folders: FolderRecord[], files: FileRecord[], totalFolders = folders.length, totalFiles = files.length) => ({
  folders,
  files,
  nextFolderCursor: null,
  nextFileCursor: null,
  totalFolders,
  totalFiles,
});

describe('useShared', () => {
  beforeEach(() => {
    vi.mocked(listSharedItems).mockReset();
    vi.mocked(unshareItem).mockReset().mockResolvedValue({} as Awaited<ReturnType<typeof unshareItem>>);
    vi.mocked(setS3PublicAccess).mockReset().mockResolvedValue({} as Awaited<ReturnType<typeof setS3PublicAccess>>);
    vi.mocked(getApiErrorMessage).mockClear();
  });
  afterEach(cleanup);

  it('exposes server totals instead of treating loaded rows as the total', async () => {
    vi.mocked(listSharedItems).mockResolvedValue(page([folder()], [file()], 25, 75));
    const { result } = renderHook(() => useShared({ token: 'token', t }));

    await act(async () => { await result.current.fetchShared(); });

    expect(result.current.totalFolders).toBe(25);
    expect(result.current.totalFiles).toBe(75);
  });

  it('keeps fetchShared stable when only the translator changes', () => {
    const firstT = (key: string) => `first:${key}`;
    const secondT = (key: string) => `second:${key}`;
    const { result, rerender } = renderHook(
      ({ translator }) => useShared({ token: 'token', t: translator }),
      { initialProps: { translator: firstT } },
    );
    const originalFetch = result.current.fetchShared;

    rerender({ translator: secondT });

    expect(result.current.fetchShared).toBe(originalFetch);
  });

  it('removes a fully revoked item without refetching or collapsing loaded rows', async () => {
    const secondFile = file({ id: 'file-2', filename: 'second.txt', shareToken: 'second-token' });
    vi.mocked(listSharedItems).mockResolvedValue(page([], [file(), secondFile], 0, 2));
    const { result } = renderHook(() => useShared({ token: 'token', t }));
    await act(async () => { await result.current.fetchShared(); });

    await act(async () => { await result.current.revoke(result.current.files[0], 'file'); });

    expect(result.current.files.map(item => item.id)).toEqual(['file-2']);
    expect(result.current.totalFiles).toBe(1);
    expect(listSharedItems).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('shared.revoked');
  });

  it('does not restore a revoked item count from snapshot totals on load more', async () => {
    vi.mocked(listSharedItems)
      .mockResolvedValueOnce({
        ...page([], [file()], 0, 2),
        nextFileCursor: 'file-cursor',
      })
      .mockResolvedValueOnce(page([], [file({ id: 'file-2' })], 0, 2));
    const { result } = renderHook(() => useShared({ token: 'token', t }));
    await act(async () => { await result.current.fetchShared(); });
    await act(async () => { await result.current.revoke(result.current.files[0], 'file'); });

    await act(async () => { await result.current.loadMoreShared(); });

    expect(result.current.totalFiles).toBe(1);
    expect(result.current.files.map(item => item.id)).toEqual(['file-2']);
  });

  it('keeps the remaining public mechanism after a partial folder revoke', async () => {
    const sharedFolder = folder({ s3PublicAccess: true });
    vi.mocked(listSharedItems).mockResolvedValue(page([sharedFolder], [], 1, 0));
    vi.mocked(setS3PublicAccess).mockRejectedValueOnce(new Error('S3 unavailable'));
    const { result } = renderHook(() => useShared({ token: 'token', t }));
    await act(async () => { await result.current.fetchShared(); });

    await act(async () => { await result.current.revoke(result.current.folders[0], 'folder'); });

    expect(result.current.folders).toHaveLength(1);
    expect(result.current.folders[0]).toMatchObject({ shareToken: null, s3PublicAccess: true });
    expect(result.current.totalFolders).toBe(1);
    expect(listSharedItems).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('shared.revokeError');
  });
});
