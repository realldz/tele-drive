import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVideoSubtitles } from '@/hooks/use-video-subtitles';
import { loadDriveSubtitle } from '@/lib/api';
import type { FileRecord } from '@/lib/types';

vi.mock('@/lib/api', () => ({ loadDriveSubtitle: vi.fn() }));
afterEach(cleanup);
const file = (id: string) => ({ id, filename: `${id}.srt` }) as FileRecord;

describe('video subtitle requests', () => {
  it('ignores a stale load and aborts it when another file is selected', async () => {
    let finish!: (text: string) => void;
    vi.mocked(loadDriveSubtitle).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce('WEBVTT new');
    const { result } = renderHook(() => useVideoSubtitles());
    let pending!: Promise<void>;
    act(() => { pending = result.current.load(file('old')); });
    const signal = vi.mocked(loadDriveSubtitle).mock.calls[0][1];
    await act(async () => { await result.current.load(file('new')); });
    await act(async () => { finish('WEBVTT old'); await pending; });
    expect(signal.aborted).toBe(true);
    expect(result.current.subtitle?.name).toBe('new.srt');
    expect(result.current.loading).toBe(false);
  });
  it('keeps the active subtitle when its replacement fails', async () => {
    vi.mocked(loadDriveSubtitle).mockResolvedValueOnce('WEBVTT old').mockRejectedValueOnce(new Error('403'));
    const { result } = renderHook(() => useVideoSubtitles());
    await act(async () => { await result.current.load(file('old')); });
    await act(async () => { await result.current.load(file('denied')); });
    expect(result.current.subtitle?.name).toBe('old.srt');
    expect(result.current.error).toBe('loadError');
  });
  it('aborts an outstanding transfer when the preview unmounts', () => {
    vi.mocked(loadDriveSubtitle).mockImplementationOnce(() => new Promise(() => {}));
    const { result, unmount } = renderHook(() => useVideoSubtitles());
    act(() => { void result.current.load(file('pending')); });
    const signal = vi.mocked(loadDriveSubtitle).mock.calls[0][1];
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
