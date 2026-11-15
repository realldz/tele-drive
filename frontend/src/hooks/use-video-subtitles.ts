'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadDriveSubtitle } from '@/lib/api';
import { readSubtitleFile, SubtitleError } from '@/lib/subtitles';
import type { FileRecord } from '@/lib/types';

export function useVideoSubtitles() {
  const [subtitle, setSubtitle] = useState<{ name: string; content: string } | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => { request.current?.abort(); }, []);

  const load = useCallback(async (file: File | FileRecord) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const local = file instanceof File;
      const content = local ? await readSubtitleFile(file) : await loadDriveSubtitle(file, controller.signal);
      if (controller.signal.aborted) return;
      setSubtitle({ name: local ? file.name : file.filename, content });
      setEnabled(true);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof SubtitleError ? cause.key : 'loadError');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  return { subtitle, enabled, setEnabled, loading, error, setError, load };
}
