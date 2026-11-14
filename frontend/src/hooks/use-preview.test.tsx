import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePreview } from './use-preview';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('usePreview', () => {
  it('ignores a stale preview request that resolves after the current one', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const { result } = renderHook(() => usePreview());

    let firstLoad!: Promise<void>;
    let secondLoad!: Promise<void>;
    act(() => {
      firstLoad = result.current.loadPreview(first.promise);
      secondLoad = result.current.loadPreview(second.promise);
    });

    await act(async () => {
      second.resolve('https://transfer.example/second');
      await secondLoad;
    });
    expect(result.current.previewUrl).toBe('https://transfer.example/second');

    await act(async () => {
      first.resolve('https://transfer.example/first');
      await firstLoad;
    });
    expect(result.current.previewUrl).toBe('https://transfer.example/second');
  });

  it('invalidates an in-flight request when preview is cleared', async () => {
    const pending = deferred<string>();
    const { result } = renderHook(() => usePreview());

    let load!: Promise<void>;
    act(() => {
      load = result.current.loadPreview(pending.promise);
      result.current.clearPreview();
    });

    await act(async () => {
      pending.resolve('https://transfer.example/stale');
      await load;
    });
    expect(result.current.previewUrl).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('renews a signed preview URL before its TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const source = vi
        .fn()
        .mockResolvedValueOnce({
          url: 'https://transfer.example/first-token',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ttl: 1,
        })
        .mockResolvedValueOnce({
          url: 'https://transfer.example/renewed-token',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ttl: 1,
        });
      const { result } = renderHook(() => usePreview());

      await act(async () => {
        await result.current.loadPreview(source);
      });
      expect(result.current.previewUrl).toContain('first-token');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(source).toHaveBeenCalledTimes(2);
      expect(result.current.previewUrl).toContain('renewed-token');
    } finally {
      vi.useRealTimers();
    }
  });
});
