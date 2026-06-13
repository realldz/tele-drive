'use client';

import { useEffect, useRef } from 'react';
import Player from 'xgplayer';
import 'xgplayer/dist/index.min.css';
import MusicPreset, { Analyze } from 'xgplayer-music';
import 'xgplayer-music/dist/index.min.css';

export function PreviewVideo({ src }: { src: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<{ destroy: () => void } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    playerRef.current = new Player({
      el: containerRef.current,
      url: src,
      height: '100%',
      width: '100%',
      videoAttributes: {
        crossOrigin: 'use-credentials',
        playsInline: true,
      },
    });

    return () => {
      if (playerRef.current) playerRef.current.destroy();
    };
  }, [src]);

  return (
    <div ref={containerRef} className="flex h-full w-full items-center justify-center bg-black" />
  );
}

export function PreviewAudio({ src }: { src: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<{ destroy: () => void } | null>(null);
  const analyzeRef = useRef<{ destroy: () => void } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    playerRef.current = new Player({
      el: containerRef.current,
      url: src,
      height: 60,
      width: '100%',
      mediaType: 'audio',
      videoAttributes: {
        crossOrigin: 'use-credentials',
        playsInline: true,
      },
      ignores: ['playbackrate'],
      controls: { mode: 'flex', initShow: true },
      marginControls: true,
      presets: ['default', MusicPreset],
      music: { list: [{ url: src, vid: src }] },
    });

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
      if (playerRef.current) playerRef.current.destroy();
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
