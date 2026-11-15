'use client';

import { useEffect, useRef, useState } from 'react';
import Player from 'xgplayer';
import 'xgplayer/dist/index.min.css';
import MusicPreset, { Analyze } from 'xgplayer-music';
import 'xgplayer-music/dist/index.min.css';
import { useVideoSubtitles } from '@/hooks/use-video-subtitles';
import VideoSubtitleControls from '@/components/organisms/preview/video-subtitle-controls';

interface PlaybackState {
  currentTime: number;
  paused: boolean;
  volume: number;
}

function capturePlaybackState(player: Player): PlaybackState {
  return {
    currentTime: Number.isFinite(player.currentTime) ? player.currentTime : 0,
    paused: player.paused,
    volume: player.volume,
  };
}

function restorePlaybackState(player: Player, state: PlaybackState | null) {
  if (!state) return;
  player.once('canplay', () => {
    player.volume = state.volume;
    if (state.currentTime > 0) player.currentTime = state.currentTime;
    if (!state.paused) {
      const result = player.play();
      void result?.catch(() => {});
    }
  });
}

export function PreviewVideo({ src }: { src: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLTrackElement | null>(null);
  const playerRef = useRef<Player | null>(null);
  const playbackStateRef = useRef<PlaybackState | null>(null);
  const [controlHost, setControlHost] = useState<HTMLElement | null>(null);
  const subtitles = useVideoSubtitles();
  const { subtitle, enabled, setError } = subtitles;

  useEffect(() => {
    if (!containerRef.current) return;

    playerRef.current = new Player({
      el: containerRef.current,
      url: src,
      height: '100%',
      width: '100%',
      fullscreenTarget: wrapperRef.current ?? undefined,
      videoAttributes: {
        crossOrigin: 'anonymous',
        playsInline: true,
      },
    });
    const host = document.createElement('div');
    host.style.cssText = 'display:flex;align-items:center;float:right;height:100%;margin:0 8px';
    const controls = playerRef.current.controls;
    controls?.right.prepend(host);
    // The portal target only exists after xgplayer creates its external DOM.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setControlHost(controls ? host : null);
    restorePlaybackState(playerRef.current, playbackStateRef.current);

    return () => {
      host.remove();
      if (playerRef.current) {
        // xgplayer.destroy does not clear CSS fullscreen on an external target.
        if (playerRef.current.cssfullscreen) playerRef.current.exitCssFullscreen();
        playbackStateRef.current = capturePlaybackState(playerRef.current);
        playerRef.current.destroy();
        playerRef.current = null;
      }
    };
  }, [src]);

  // Use the browser's WebVTT renderer: subtitle markup never becomes page HTML.
  // Reattach when a renewed signed video URL recreates the player.
  useEffect(() => {
    const media = playerRef.current?.video;
    if (!(media instanceof HTMLVideoElement) || !subtitle) return;
    const url = URL.createObjectURL(new Blob([subtitle.content], { type: 'text/vtt' }));
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = subtitle.name;
    track.srclang = 'und';
    track.src = url;
    const onLoad = () => { if (!track.track.cues?.length) setError('invalidContent'); };
    const onError = () => setError('invalidContent');
    track.addEventListener('load', onLoad);
    track.addEventListener('error', onError);
    media.appendChild(track);
    trackRef.current = track;
    // hidden loads cues even when the user has switched subtitles off.
    track.track.mode = 'hidden';
    return () => {
      track.removeEventListener('load', onLoad);
      track.removeEventListener('error', onError);
      track.remove();
      trackRef.current = null;
      URL.revokeObjectURL(url);
    };
  }, [src, subtitle, setError]);

  useEffect(() => {
    if (trackRef.current) trackRef.current.track.mode = enabled ? 'showing' : 'hidden';
  }, [src, subtitle, enabled]);

  return (
    <div ref={wrapperRef} className="relative flex h-full w-full flex-col bg-black">
      <div className="relative z-0 min-h-0 flex-1">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      <VideoSubtitleControls {...subtitles} controlHost={controlHost} />
    </div>
  );
}

export function PreviewAudio({ src }: { src: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<Player | null>(null);
  const analyzeRef = useRef<{ destroy: () => void } | null>(null);
  const playbackStateRef = useRef<PlaybackState | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    playerRef.current = new Player({
      el: containerRef.current,
      url: src,
      height: 60,
      width: '100%',
      mediaType: 'audio',
      videoAttributes: {
        crossOrigin: 'anonymous',
        playsInline: true,
      },
      ignores: ['playbackrate'],
      controls: { mode: 'flex', initShow: true },
      marginControls: true,
      presets: ['default', MusicPreset],
      music: { list: [{ url: src, vid: src }] },
    });
    restorePlaybackState(playerRef.current, playbackStateRef.current);

    if (canvasRef.current) {
      analyzeRef.current = new Analyze(playerRef.current, canvasRef.current, {
        mode: 'bars',
        stroke: 2,
        colors: ['#3b82f6', '#3b82f6', '#60a5fa'],
        bgColor: 'transparent',
      });
    }

    return () => {
      if (analyzeRef.current) analyzeRef.current.destroy();
      analyzeRef.current = null;
      if (playerRef.current) {
        playbackStateRef.current = capturePlaybackState(playerRef.current);
        playerRef.current.destroy();
        playerRef.current = null;
      }
    };
  }, [src]);

  return (
    <div className="flex h-full flex-col items-center justify-center p-4 bg-gray-100">
      <canvas ref={canvasRef} className="h-32 w-full max-w-xl" />
      <div className="w-full max-w-xl">
        <div ref={containerRef} />
      </div>
    </div>
  );
}
