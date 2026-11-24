import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSharedFolder } from '@/app/share/folder/[token]/use-shared-folder';
import { api } from '@/lib/api';
import type { FileRecord } from '@/lib/types';

const pushMock = vi.fn();
const replaceMock = vi.fn();
let currentSearch = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => '/share/folder/share-tok',
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

const stableT = (k: string) => k;
const startSharedDownloadMock = vi.fn();

vi.mock('@/providers/i18n-context', () => ({
  useI18n: () => ({ t: stableT }),
}));

vi.mock('@/providers/download-context', () => ({
  useDownload: () => ({ startSharedDownload: startSharedDownloadMock }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn() },
  resolveTransferLink: vi.fn((u: string) => u),
  requestShareFolderDownloadToken: vi.fn(),
  parseBandwidthError: vi.fn(() => null),
  getApiErrorMessage: vi.fn((_err: unknown, fallback: string) => fallback),
}));

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const sharedResponse = (overrides: Record<string, unknown> = {}) => ({
  data: {
    rootFolder: { id: 'root-1', name: 'Shared Root', user: { username: 'alice' } },
    folders: [],
    files: [],
    breadcrumbs: [{ id: 'root-1', name: 'Shared Root' }],
    nextFolderCursor: null,
    nextFileCursor: null,
    ...overrides,
  },
});

const axiosStatusError = (status: number) =>
  new AxiosError(
    `Request failed with status ${status}`,
    undefined,
    undefined,
    undefined,
    {
      status,
      statusText: 'Error',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: { message: 'err' },
    },
  );

describe('useSharedFolder URL navigation', () => {
  beforeEach(() => {
    pushMock.mockReset();
    replaceMock.mockReset();
    currentSearch = '';
    vi.mocked(api.get).mockReset().mockResolvedValue(sharedResponse());
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('normalizes root breadcrumb click to root URL without redundant query param', async () => {
    currentSearch = 'folder=child-1';
    const { result } = renderHook(() => useSharedFolder('share-tok'));

    await waitFor(() => {
      expect(result.current.rootFolder?.id).toBe('root-1');
    });

    act(() => {
      result.current.setCurrentFolderId('root-1');
    });

    expect(pushMock).toHaveBeenCalledWith('/share/folder/share-tok', { scroll: false });
  });

  it('canonicalizes direct ?folder=<rootId> URL via replace without pushing', async () => {
    currentSearch = 'folder=root-1';
    renderHook(() => useSharedFolder('share-tok'));

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/share/folder/share-tok', { scroll: false });
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('recovers to shared root on 400 stale subfolder error, but shows error on 404 invalid token', async () => {
    currentSearch = 'folder=deleted-sub';
    vi.mocked(api.get).mockRejectedValueOnce(axiosStatusError(400));

    const { result, unmount } = renderHook(() => useSharedFolder('share-tok'));

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/share/folder/share-tok', { scroll: false });
    });
    expect(result.current.error).toBeNull();
    unmount();

    currentSearch = '';
    replaceMock.mockReset();
    vi.mocked(api.get).mockRejectedValueOnce(axiosStatusError(404));
    const invalid = renderHook(() => useSharedFolder('bad-tok'));

    await waitFor(() => {
      expect(invalid.result.current.error).toBe('shareFolder.folderNotFound');
    });
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('clears preview modal and resets scroll when folder changes via Back/Forward', async () => {
    const { result, rerender } = renderHook(() => useSharedFolder('share-tok'));

    await waitFor(() => {
      expect(result.current.rootFolder?.id).toBe('root-1');
    });

    act(() => {
      result.current.setPreviewFile({ id: 'file-1', filename: 'a.txt' } as FileRecord);
    });
    expect(result.current.previewFile?.id).toBe('file-1');

    currentSearch = 'folder=child-2';
    rerender();

    await waitFor(() => {
      expect(result.current.previewFile).toBeNull();
    });
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });
});
