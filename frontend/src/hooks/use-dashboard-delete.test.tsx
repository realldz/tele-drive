import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardDelete } from '@/hooks/use-dashboard-delete';
import { deleteFile, deleteFolder, fetchBreadcrumbs } from '@/lib/api';
import type { SelectionState } from '@/hooks/use-selection';

vi.mock('@/lib/api', () => ({ deleteFile: vi.fn(), deleteFolder: vi.fn(), restoreFile: vi.fn(), restoreFolder: vi.fn(), fetchBreadcrumbs: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: { loading: vi.fn(() => 'progress'), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => { vi.mocked(deleteFolder).mockResolvedValue({ data: { id: 'root', deletedFolderIds: ['root', 'hidden'] } } as Awaited<ReturnType<typeof deleteFolder>>); });

describe('dashboard deletion', () => {
  const t = (key: string) => key;
  const selection = (ids: string[]) => ({ selectedIds: new Set(ids), selectAll: vi.fn() }) as unknown as SelectionState;

  it('routes a search folder through the folder endpoint and refreshes the active dataset', async () => {
    const refresh = vi.fn();
    const selected = selection(['search-folder']);
    const { result } = renderHook(() => useDashboardDelete({ t, selection: selected,
      folders: [{ id: 'search-folder', parentId: null }], files: [], refresh, removeItems: vi.fn() }));
    await act(async () => { await result.current.handleBatchDelete(); });
    expect(deleteFolder).toHaveBeenCalledExactlyOnceWith('search-folder');
    expect(deleteFile).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(selected.selectAll).toHaveBeenCalledWith([]);
  });

  it('deletes a selected ancestor once even when a nested result is encountered first', async () => {
    vi.mocked(fetchBreadcrumbs).mockResolvedValue([{ id: 'root', name: 'Root' }, { id: 'hidden', name: 'Hidden' }]);
    const selected = selection(['nested-file', 'root']);
    const { result } = renderHook(() => useDashboardDelete({ t, selection: selected,
      folders: [{ id: 'root', parentId: null }], files: [{ id: 'nested-file', folderId: 'hidden' }],
      refresh: vi.fn(), removeItems: vi.fn() }));
    await act(async () => { await result.current.handleBatchDelete(); });
    expect(deleteFolder).toHaveBeenCalledExactlyOnceWith('root');
    expect(deleteFile).not.toHaveBeenCalled();
    expect(selected.selectAll).toHaveBeenCalledWith([]);
  });

  it('removes unselected descendants when another selected item fails', async () => {
    const removeItems = vi.fn();
    const selected = selection(['root', 'failed']);
    vi.mocked(deleteFile).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useDashboardDelete({ t, selection: selected,
      folders: [{ id: 'root', parentId: null }],
      files: [{ id: 'unselected-child', folderId: 'hidden' }, { id: 'failed', folderId: null }],
      refresh: vi.fn(), removeItems }));
    await act(async () => { await result.current.handleBatchDelete(); });
    expect(removeItems).toHaveBeenCalledWith(['root', 'unselected-child']);
    expect(selected.selectAll).toHaveBeenCalledWith(['failed']);
  });
});
