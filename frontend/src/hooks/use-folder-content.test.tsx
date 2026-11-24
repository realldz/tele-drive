import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFolderContent } from '@/hooks/use-folder-content';
import {
  fetchBreadcrumbs,
  fetchFolderContentInitial,
  fetchFolderContentNextPage,
} from '@/lib/api';

const pushMock = vi.fn();
const replaceMock = vi.fn();
let currentSearch = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

vi.mock('@/lib/api', () => ({
  fetchBreadcrumbs: vi.fn(),
  fetchFolderContentInitial: vi.fn(),
  fetchFolderContentNextPage: vi.fn(),
}));

vi.mock('@/hooks/use-buffer-sync', () => ({
  useBufferSync: vi.fn(),
}));

const emptyContent = {
  folders: [],
  files: [],
  nextFolderCursor: null,
  nextFileCursor: null,
  totalFolders: 0,
  totalFiles: 0,
};

describe('useFolderContent URL sync', () => {
  beforeEach(() => {
    pushMock.mockReset();
    replaceMock.mockReset();
    currentSearch = '';
    vi.mocked(fetchFolderContentInitial).mockReset().mockResolvedValue(emptyContent);
    vi.mocked(fetchFolderContentNextPage).mockReset();
    vi.mocked(fetchBreadcrumbs).mockReset().mockResolvedValue([]);
  });

  afterEach(cleanup);

  it('fetches folder content and breadcrumbs for folder from URL query', async () => {
    currentSearch = 'folder=folder-42';
    vi.mocked(fetchBreadcrumbs).mockResolvedValue([{ id: 'folder-42', name: 'Projects' }]);

    const { result } = renderHook(() => useFolderContent('jwt-token'));

    await waitFor(() => {
      expect(fetchFolderContentInitial).toHaveBeenCalledWith('folder-42', undefined, 'name', 'asc', false);
      expect(fetchBreadcrumbs).toHaveBeenCalledWith('folder-42', false);
      expect(result.current.breadcrumbs).toEqual([{ id: 'folder-42', name: 'Projects' }]);
    });
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('replaces URL back to root when breadcrumbs are empty and keeps loading state to avoid empty flash', async () => {
    currentSearch = 'folder=deleted-id';
    vi.mocked(fetchBreadcrumbs).mockResolvedValue([]);

    const { result } = renderHook(() => useFolderContent('jwt-token'));

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/', { scroll: false });
    });
    expect(result.current.isLoadingContent).toBe(true);
  });

  it('does not refetch when unrelated query parameters change', async () => {
    currentSearch = 'folder=folder-42&ref=a';
    vi.mocked(fetchBreadcrumbs).mockResolvedValue([{ id: 'folder-42', name: 'Projects' }]);

    const { rerender } = renderHook(() => useFolderContent('jwt-token'));

    await waitFor(() => {
      expect(fetchFolderContentInitial).toHaveBeenCalledTimes(1);
    });

    currentSearch = 'folder=folder-42&ref=b';
    rerender();

    await waitFor(() => {
      expect(fetchFolderContentInitial).toHaveBeenCalledTimes(1);
    });
  });

  it('drops stale responses when navigating Back/Forward rapidly between folders', async () => {
    let resolveFirst!: (value: typeof emptyContent) => void;
    const firstPromise = new Promise<typeof emptyContent>((resolve) => {
      resolveFirst = resolve;
    });

    currentSearch = 'folder=folder-1';
    vi.mocked(fetchFolderContentInitial)
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce({
        ...emptyContent,
        folders: [{ id: 'child-of-2', name: 'From Folder 2' } as never],
      });
    vi.mocked(fetchBreadcrumbs).mockResolvedValue([{ id: 'folder-2', name: 'Folder 2' }]);

    const { result, rerender } = renderHook(() => useFolderContent('jwt-token'));

    currentSearch = 'folder=folder-2';
    rerender();

    await waitFor(() => {
      expect(result.current.folders.map((f) => f.id)).toEqual(['child-of-2']);
    });

    await act(async () => {
      resolveFirst({
        ...emptyContent,
        folders: [{ id: 'stale-child-of-1', name: 'Stale' } as never],
      });
      await Promise.resolve();
    });

    expect(result.current.folders.map((f) => f.id)).toEqual(['child-of-2']);
  });

  it('does not redirect to root when fetchBreadcrumbs rejects due to network error', async () => {
    currentSearch = 'folder=folder-42';
    vi.mocked(fetchBreadcrumbs).mockRejectedValue(new Error('Network error'));

    renderHook(() => useFolderContent('jwt-token'));

    await waitFor(() => {
      expect(fetchBreadcrumbs).toHaveBeenCalledWith('folder-42', false);
    });
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('pushes URL query when setCurrentFolderId is called', async () => {
    const { result } = renderHook(() => useFolderContent('jwt-token'));

    await waitFor(() => {
      expect(fetchFolderContentInitial).toHaveBeenCalled();
    });

    act(() => {
      result.current.setCurrentFolderId('folder-99');
    });

    expect(pushMock).toHaveBeenCalledWith('/?folder=folder-99', { scroll: false });
  });
});
