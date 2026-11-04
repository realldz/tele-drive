import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import {
  RequestTrackerProvider, useRequestTracker, incPendingCount, decPendingCount,
} from '@/providers/request-tracker';

function Probe() {
  const { pendingCount, showOverlay } = useRequestTracker();
  return <div data-testid="tracker">{`${pendingCount}:${showOverlay}`}</div>;
}

describe('RequestTrackerProvider', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('tracks interceptor calls and hides the overlay when requests complete', () => {
    vi.useFakeTimers();
    render(<RequestTrackerProvider><Probe /></RequestTrackerProvider>);

    act(() => incPendingCount());
    expect(screen.getByTestId('tracker').textContent).toBe('1:false');
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId('tracker').textContent).toBe('1:true');
    act(() => decPendingCount());
    expect(screen.getByTestId('tracker').textContent).toBe('0:false');
  });

  it('does not show the overlay for requests completed before the delay', () => {
    vi.useFakeTimers();
    render(<RequestTrackerProvider><Probe /></RequestTrackerProvider>);
    act(() => incPendingCount());
    act(() => decPendingCount());
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId('tracker').textContent).toBe('0:false');
  });

  it('excludes background API requests from the pending count', async () => {
    render(<RequestTrackerProvider><Probe /></RequestTrackerProvider>);
    let finish!: () => void;
    const request = api.get('/background-test', {
      skipRequestOverlay: true,
      adapter: config => new Promise(resolve => {
        finish = () => resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config });
      }),
    });

    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(screen.getByTestId('tracker').textContent).toBe('0:false');
    await act(async () => { finish(); await request; });
    expect(screen.getByTestId('tracker').textContent).toBe('0:false');
  });
});
