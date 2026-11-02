import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useItemActions } from '@/hooks/use-item-actions';
import toast from 'react-hot-toast';

vi.mock('react-hot-toast', () => ({ default: { loading: vi.fn(() => 'progress'), success: vi.fn(), error: vi.fn() } }));
const t = (key: string) => key;
afterEach(cleanup);

describe('item operations', () => {
  it('rejects a second click before render and keeps progress until completion', async () => {
    let finish!: () => void;
    const action = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const refresh = vi.fn();
    const remove = vi.fn();
    const { result } = renderHook(() => useItemActions(t, refresh, remove));
    let pending: ReturnType<typeof result.current.run>;
    act(() => { pending = result.current.run([{ id: 'folder', type: 'folder' }], action); });
    expect(result.current.pendingIds.has('folder')).toBe(true);
    expect(await result.current.run([{ id: 'folder', type: 'folder' }], action)).toBeNull();
    expect(action).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await pending; });
    expect(result.current.isBusy).toBe(false);
    expect(remove).toHaveBeenCalledWith(['folder']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('preserves failed rows on later pages and never reports full success', async () => {
    const refresh = vi.fn();
    const remove = vi.fn();
    const action = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('timeout'));
    const { result } = renderHook(() => useItemActions(t, refresh, remove));
    let outcome;
    await act(async () => {
      outcome = await result.current.run([{ id: 'ok', type: 'file' }, { id: 'failed', type: 'folder' }], action);
    });
    expect(outcome).toMatchObject({ completedIds: ['ok'], failedIds: ['failed'] });
    expect(remove).toHaveBeenCalledExactlyOnceWith(['ok']);
    expect(refresh).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('actions.partialFailure', { id: 'progress' });
    expect(result.current.pendingIds.size).toBe(0);
  });
});
