import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SubtitleDrivePicker from '@/components/organisms/preview/subtitle-drive-picker';
import { searchFiles, type PaginatedFolderContent } from '@/lib/api';
import { SEARCH_DEBOUNCE_MS, SUBTITLE_MAX_BYTES } from '@/lib/constants';
import type { FileRecord } from '@/lib/types';

vi.mock('@/lib/api', () => ({ searchFiles: vi.fn(), formatBytes: (size: number) => `${size} B` }));
vi.mock('@/providers/i18n-context', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function file(id: string, filename = `${id}.srt`, status = 'complete', size = 50): FileRecord {
  return { id, filename, status, size, mimeType: 'text/plain', totalChunks: 1, folderId: null,
    userId: 'owner', visibility: 'private', shareToken: null, createdAt: '', updatedAt: '' };
}

function page(files: FileRecord[], nextFileCursor: string | null = null): PaginatedFolderContent {
  return { files, nextFileCursor, folders: [], nextFolderCursor: 'ignore-folder-cursor', totalFiles: 0, totalFolders: 0 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

async function debounce() {
  await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS); });
}

function show(onSelect = vi.fn(), onClose = vi.fn()) {
  return render(createElement(SubtitleDrivePicker, { onSelect, onClose }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(searchFiles).mockReset();
  vi.mocked(searchFiles).mockResolvedValue(page([]));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SubtitleDrivePicker', () => {
  it('filters extensions, permits buffered files, and disables oversized or incomplete files', async () => {
    const selected = vi.fn();
    const buffered = file('buffered', 'BUFFERED.SRT', 'buffered', SUBTITLE_MAX_BYTES);
    vi.mocked(searchFiles).mockResolvedValue(page([
      buffered, file('other', 'other.vtt'), file('large', 'large.srt', 'complete', SUBTITLE_MAX_BYTES + 1),
      file('pending', 'pending.srt', 'uploading'), file('failed', 'failed.srt', 'buffer_failed'),
    ]));
    show(selected);
    await debounce();
    expect(searchFiles).toHaveBeenCalledWith({ type: 'file', q: 'srt', cursor: null });
    expect(screen.queryByText('other.vtt')).toBeNull();
    fireEvent.click(screen.getByText('BUFFERED.SRT'));
    expect(selected).toHaveBeenCalledWith(buffered);
    for (const name of ['large.srt', 'pending.srt', 'failed.srt']) {
      expect((screen.getByText(name).closest('button') as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('ignores stale searches and clears results/cursors before fetching a new extension', async () => {
    const stale = deferred<PaginatedFolderContent>();
    vi.mocked(searchFiles).mockReturnValueOnce(stale.promise).mockResolvedValueOnce(page([file('new', 'new.VTT')]));
    show();
    await debounce();
    fireEvent.change(screen.getByLabelText('subtitles.format'), { target: { value: 'vtt' } });
    await act(async () => { stale.resolve(page([file('stale')], 'stale-cursor')); });
    expect(screen.queryByText('stale.srt')).toBeNull();
    await debounce();
    expect(searchFiles).toHaveBeenLastCalledWith({ type: 'file', q: 'vtt', cursor: null });
    expect(screen.getByText('new.VTT')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('subtitles.search'), { target: { value: 'episode' } });
    expect(screen.queryByText('new.VTT')).toBeNull();
    expect(screen.queryByText('subtitles.loadMore')).toBeNull();
    await debounce();
    expect(searchFiles).toHaveBeenLastCalledWith({ type: 'file', q: 'episode', cursor: null });
  });

  it('paginates only files, deduplicates rows and guards duplicate requests', async () => {
    const more = deferred<PaginatedFolderContent>();
    vi.mocked(searchFiles).mockResolvedValueOnce(page([file('first')], 'file-cursor')).mockReturnValueOnce(more.promise);
    show();
    await debounce();
    const button = screen.getByText('subtitles.loadMore');
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(searchFiles).toHaveBeenCalledTimes(2);
    expect(searchFiles).toHaveBeenLastCalledWith({ type: 'file', q: 'srt', cursor: 'file-cursor' });
    await act(async () => { more.resolve(page([file('first'), file('second')])); });
    expect(screen.getAllByText('first.srt')).toHaveLength(1);
    expect(screen.getByText('second.srt')).toBeTruthy();
    expect(screen.queryByText('subtitles.loadMore')).toBeNull();
  });

  it('retries a failed page without discarding prior matches', async () => {
    vi.mocked(searchFiles).mockResolvedValueOnce(page([file('first')], 'next'))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([file('second')]));
    show();
    await debounce();
    await act(async () => { fireEvent.click(screen.getByText('subtitles.loadMore')); });
    expect(screen.getByRole('alert')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('subtitles.retry')); });
    expect(searchFiles).toHaveBeenLastCalledWith({ type: 'file', q: 'srt', cursor: 'next' });
    expect(screen.getByText('first.srt')).toBeTruthy();
    expect(screen.getByText('second.srt')).toBeTruthy();
  });

  it('focuses search, traps Tab, keeps Escape from the outer preview, and restores focus', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const outerEscape = vi.fn();
    const close = vi.fn();
    document.addEventListener('keydown', outerEscape);
    const view = show(vi.fn(), close);
    expect(document.activeElement).toBe(screen.getByLabelText('subtitles.search'));
    const closeButton = screen.getByLabelText('subtitles.close');
    closeButton.focus();
    fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText('subtitles.format'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(outerEscape).not.toHaveBeenCalled();
    view.unmount();
    expect(document.activeElement).toBe(opener);
    document.removeEventListener('keydown', outerEscape);
    opener.remove();
  });

  it('ignores a response after unmount and cancels a queued debounce', async () => {
    const pending = deferred<PaginatedFolderContent>();
    vi.mocked(searchFiles).mockReturnValueOnce(pending.promise);
    const first = show();
    await debounce();
    first.unmount();
    await act(async () => { pending.resolve(page([file('late')])); });
    const second = show();
    second.unmount();
    await debounce();
    expect(searchFiles).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
