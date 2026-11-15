import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDriveSubtitle } from '@/lib/api/subtitles';
import { getPreviewUrl } from '@/lib/api/transfer';
import { SUBTITLE_MAX_BYTES } from '@/lib/constants';
import type { FileRecord } from '@/lib/types';

vi.mock('@/lib/api/transfer', () => ({ getPreviewUrl: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
const file = { id: 'sub', filename: 'movie.srt', size: 50 } as FileRecord;
const source = '1\n00:00:01,000 --> 00:00:02,000\nXin chào';

function mockResponse(chunks: Uint8Array[], contentLength?: string) {
  const read = vi.fn();
  for (const value of chunks) read.mockResolvedValueOnce({ value, done: false });
  read.mockResolvedValue({ done: true });
  const cancel = vi.fn().mockResolvedValue(undefined);
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: new Headers(contentLength ? { 'content-length': contentLength } : {}), body: { getReader: () => ({ read, cancel }) } });
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(getPreviewUrl).mockResolvedValue({ url: 'https://transfer.example/signed', expiresAt: '', ttl: 3600 });
  return { fetchMock, cancel };
}

describe('Tele-Drive subtitle transfer', () => {
  it('uses an authorized signed URL without forwarding credentials and decodes split UTF-8', async () => {
    const bytes = new TextEncoder().encode(source);
    const { fetchMock, cancel } = mockResponse([bytes.slice(0, -1), bytes.slice(-1)]);
    const result = await loadDriveSubtitle(file, new AbortController().signal);
    expect(result).toContain('Xin chào');
    expect(result).toContain('00:00:01.000');
    expect(getPreviewUrl).toHaveBeenCalledWith('sub');
    expect(fetchMock).toHaveBeenCalledWith('https://transfer.example/signed', { credentials: 'omit', signal: expect.any(AbortSignal) });
    expect(cancel).toHaveBeenCalled();
  });
  it('bounds streamed bytes even when content-length is missing', async () => {
    const { cancel } = mockResponse([new Uint8Array(SUBTITLE_MAX_BYTES + 1)]);
    await expect(loadDriveSubtitle(file, new AbortController().signal)).rejects.toThrow('tooLarge');
    expect(cancel).toHaveBeenCalled();
  });
  it('rejects oversized content-length before reading the body', async () => {
    const { cancel } = mockResponse([], String(SUBTITLE_MAX_BYTES + 1));
    await expect(loadDriveSubtitle(file, new AbortController().signal)).rejects.toThrow('tooLarge');
    expect(cancel).not.toHaveBeenCalled();
  });
  it('does not fetch a signed URL after the caller cancels authorization', async () => {
    const { fetchMock } = mockResponse([]);
    const controller = new AbortController();
    controller.abort();
    await expect(loadDriveSubtitle(file, controller.signal)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
