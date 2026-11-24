import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFolderHref, useFolderQueryNavigation } from '@/hooks/use-folder-query-navigation';

const pushMock = vi.fn();
const replaceMock = vi.fn();
let currentPathname = '/';
let currentSearch = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => currentPathname,
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

describe('buildFolderHref', () => {
  it('sets folder query param when folderId is provided', () => {
    expect(buildFolderHref('/', new URLSearchParams(''), 'folder-1')).toBe('/?folder=folder-1');
  });

  it('removes folder query param when navigating to root', () => {
    expect(buildFolderHref('/', new URLSearchParams('folder=folder-1'), undefined)).toBe('/');
  });

  it('preserves unrelated query parameters', () => {
    expect(buildFolderHref('/share/folder/abc', new URLSearchParams('ref=email&folder=old'), 'new')).toBe(
      '/share/folder/abc?ref=email&folder=new',
    );
    expect(buildFolderHref('/share/folder/abc', new URLSearchParams('ref=email&folder=old'), undefined)).toBe(
      '/share/folder/abc?ref=email',
    );
  });
});

describe('useFolderQueryNavigation', () => {
  beforeEach(() => {
    pushMock.mockReset();
    replaceMock.mockReset();
    currentPathname = '/';
    currentSearch = '';
  });

  afterEach(cleanup);

  it('reads currentFolderId from URL search params and normalizes empty values to undefined', () => {
    currentSearch = 'folder=abc-123';
    const { result, rerender } = renderHook(() => useFolderQueryNavigation());
    expect(result.current.currentFolderId).toBe('abc-123');

    currentSearch = 'folder=%20%20';
    rerender();
    expect(result.current.currentFolderId).toBeUndefined();
  });

  it('pushes new history entries with scroll disabled and skips redundant pushes', () => {
    const { result, rerender } = renderHook(() => useFolderQueryNavigation());

    act(() => {
      result.current.navigateToFolder(undefined);
    });
    expect(pushMock).not.toHaveBeenCalled();

    act(() => {
      result.current.navigateToFolder('folder-1');
    });
    expect(pushMock).toHaveBeenCalledWith('/?folder=folder-1', { scroll: false });

    currentSearch = 'folder=folder-1';
    rerender();
    pushMock.mockClear();

    act(() => {
      result.current.navigateToFolder('folder-1');
    });
    expect(pushMock).not.toHaveBeenCalled();

    act(() => {
      result.current.navigateToFolder(undefined);
    });
    expect(pushMock).toHaveBeenCalledWith('/', { scroll: false });
  });

  it('replaces history entry without pushing when calling replaceFolder', () => {
    currentSearch = 'folder=deleted-folder';
    const { result } = renderHook(() => useFolderQueryNavigation());

    act(() => {
      result.current.replaceFolder(undefined);
    });

    expect(replaceMock).toHaveBeenCalledWith('/', { scroll: false });
    expect(pushMock).not.toHaveBeenCalled();
  });
});
