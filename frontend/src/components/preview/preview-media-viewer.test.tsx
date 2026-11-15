import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewVideo } from '@/components/preview/preview-media-viewer';
import { loadDriveSubtitle } from '@/lib/api';
import type { FileRecord } from '@/lib/types';

vi.mock('@/lib/api', () => ({ loadDriveSubtitle: vi.fn() }));
vi.mock('@/providers/auth-context', () => ({ useAuth: () => ({ token: 'token', user: { id: 'viewer' } }) }));
vi.mock('@/providers/i18n-context', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/organisms/preview/subtitle-drive-picker', () => ({
  default: ({ onSelect }: { onSelect: (file: FileRecord) => void }) => <button onClick={() => onSelect({ id: 'sub', filename: 'movie.srt' } as FileRecord)}>choose subtitle</button>,
}));
vi.mock('xgplayer-music', () => ({ default: {}, Analyze: class {} }));
vi.mock('xgplayer', () => ({ default: class {
  video = document.createElement('video');
  currentTime = 42;
  paused = true;
  volume = 1;
  controls = { right: document.createElement('div') };
  cssfullscreen = false;
  target: HTMLElement;
  constructor(options: { el: HTMLElement; fullscreenTarget: HTMLElement }) {
    this.target = options.fullscreenTarget;
    this.controls.right.className = 'xg-right-grid';
    const fullscreen = document.createElement('button');
    fullscreen.textContent = 'web fullscreen';
    fullscreen.onclick = () => {
      this.cssfullscreen = true;
      this.target.classList.add('xgplayer-fullscreen-parent');
    };
    this.controls.right.append(fullscreen);
    options.el.append(this.video, this.controls.right);
  }
  exitCssFullscreen() { this.target.classList.remove('xgplayer-fullscreen-parent'); }
  once() {}
  destroy() { this.video.remove(); this.controls.right.remove(); }
} }));

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:subtitle');
    static revokeObjectURL = vi.fn();
  });
  Object.defineProperty(HTMLTrackElement.prototype, 'track', {
    configurable: true,
    get() {
      if (!this._textTrack) this._textTrack = { mode: 'disabled', cues: [{}] };
      return this._textTrack;
    },
  });
  vi.mocked(loadDriveSubtitle).mockResolvedValue('WEBVTT\n\n00:01.000 --> 00:02.000\nHello\n');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function choose() {
  fireEvent.click(screen.getByRole('button', { name: 'subtitles.label' }));
  fireEvent.click(screen.getByText('subtitles.drive'));
  await act(async () => { fireEvent.click(screen.getByText('choose subtitle')); });
}

describe('video subtitle track lifecycle', () => {
  it('places one subtitle button in player controls and opens a dismissible menu', () => {
    const view = render(<PreviewVideo src="/video" />);
    const button = screen.getByRole('button', { name: 'subtitles.label' });
    expect(button.closest('.xg-right-grid')).toBeTruthy();
    expect(screen.queryByText('subtitles.drive')).toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole('dialog')).toBeTruthy();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outer);
    fireEvent.click(screen.getByText('web fullscreen'));
    expect(view.container.querySelector('.xgplayer-fullscreen-parent')).toBeTruthy();
    view.rerender(<PreviewVideo src="/video?renewed" />);
    expect(view.container.querySelector('.xgplayer-fullscreen-parent')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'subtitles.label' })).toHaveLength(1);
  });
  it('attaches and toggles tracks without recreating playback, survives URL renewal and cleans up', async () => {
    const view = render(<PreviewVideo src="/video?token=one" />);
    const originalVideo = view.container.querySelector('video');
    await choose();
    let track = view.container.querySelector('track')!;
    expect(track.kind).toBe('subtitles');
    expect(track.track.mode).toBe('showing');
    expect(view.container.querySelector('video')).toBe(originalVideo);
    fireEvent.click(screen.getByText('subtitles.turnOff'));
    expect(track.track.mode).toBe('hidden');
    view.rerender(<PreviewVideo src="/video?token=two" />);
    track = view.container.querySelector('track')!;
    expect(view.container.querySelector('video')).not.toBe(originalVideo);
    expect(track.track.mode).toBe('hidden');
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('subtitles.turnOn'));
    expect(track.track.mode).toBe('showing');
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it('reports browser subtitle parse failures', async () => {
    const view = render(<PreviewVideo src="/video" />);
    await choose();
    fireEvent.error(view.container.querySelector('track')!);
    expect(screen.getByRole('alert').textContent).toBe('subtitles.invalidContent');
  });
});
