import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTrashCleanup } from '@/hooks/use-trash-cleanup';
import { getCleanupStatus, startCleanup } from '@/lib/api';

vi.mock('@/lib/api', () => ({ getCleanupStatus: vi.fn(), startCleanup: vi.fn() }));
vi.mock('@/lib/constants', () => ({ TRASH_CLEANUP_POLL_MS: 10 }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
const t = (key: string) => key;
afterEach(cleanup);
beforeEach(() => { vi.mocked(getCleanupStatus).mockReset(); vi.spyOn(window, 'confirm').mockReturnValue(true); });

describe('trash cleanup lifecycle', () => {
  it('discovers a running cleanup on mount and unlocks when it finishes', async () => {
    vi.mocked(getCleanupStatus).mockResolvedValueOnce({ isCleaning: true }).mockResolvedValue({ isCleaning: false, deletedCount: 4 });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useTrashCleanup('token', t, refresh));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(result.current.cleanupStatus.isCleaning).toBe(false);
    expect(result.current.isEmptying).toBe(false);
  });

  it('handles accepted=false without entering a permanent loading state', async () => {
    vi.mocked(getCleanupStatus).mockResolvedValue({ isCleaning: false });
    vi.mocked(startCleanup).mockResolvedValue({ accepted: false });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useTrashCleanup('token', t, refresh));
    await waitFor(() => expect(result.current.isEmptying).toBe(false));
    await act(async () => { await result.current.start(); });
    expect(result.current.isEmptying).toBe(false);
    expect(result.current.cleanupStatus.isCleaning).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('unlocks after a cleanup started from this page completes', async () => {
    vi.mocked(getCleanupStatus).mockResolvedValue({ isCleaning: false });
    vi.mocked(startCleanup).mockResolvedValue({ accepted: true });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useTrashCleanup('token', t, refresh));
    await waitFor(() => expect(result.current.isEmptying).toBe(false));
    vi.mocked(getCleanupStatus).mockResolvedValue({ isCleaning: true });
    await act(async () => { await result.current.start(); });
    expect(result.current.cleanupStatus.isCleaning).toBe(true);
    vi.mocked(getCleanupStatus).mockResolvedValue({ isCleaning: false, deletedCount: 3 });
    await waitFor(() => expect(result.current.cleanupStatus.isCleaning).toBe(false));
    expect(result.current.isEmptying).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('exposes status errors and recovers on retry instead of silently locking the page', async () => {
    vi.mocked(getCleanupStatus).mockRejectedValue(new Error('offline'));
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useTrashCleanup('token', t, refresh));
    await waitFor(() => expect(result.current.statusError).toBe(true));
    vi.mocked(getCleanupStatus).mockResolvedValue({ isCleaning: false });
    act(() => result.current.retryStatus());
    await waitFor(() => expect(result.current.statusError).toBe(false));
    expect(result.current.isEmptying).toBe(false);
  });

  it('keeps actions blocked after an ambiguous start failure until status is known', async () => {
    vi.mocked(getCleanupStatus).mockResolvedValue({ isCleaning: false });
    vi.mocked(startCleanup).mockRejectedValue(new Error('timeout'));
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useTrashCleanup('token', t, refresh));
    await waitFor(() => expect(result.current.isEmptying).toBe(false));
    vi.mocked(getCleanupStatus).mockRejectedValue(new Error('offline'));
    await act(async () => { await result.current.start(); });
    await waitFor(() => expect(result.current.statusError).toBe(true));
    expect(result.current.isEmptying).toBe(true);
    vi.mocked(getCleanupStatus).mockResolvedValue({ isCleaning: true });
    act(() => result.current.retryStatus());
    await waitFor(() => expect(result.current.cleanupStatus.isCleaning).toBe(true));
  });
});
