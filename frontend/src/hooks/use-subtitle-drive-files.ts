'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { searchFiles } from '@/lib/api';
import { SEARCH_DEBOUNCE_MS } from '@/lib/constants';
import type { FileRecord } from '@/lib/types';

export type SubtitleExtension = 'srt' | 'vtt';

type SearchSession = {
  active: boolean;
  pending: boolean;
  query: string;
  extension: SubtitleExtension;
  cursor: string | null;
};

type SearchState = {
  files: FileRecord[];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
};

const INITIAL_STATE: SearchState = { files: [], loading: true, error: false, hasMore: false };

export function useSubtitleDriveFiles() {
  const [query, setQuery] = useState('');
  const [extension, setExtension] = useState<SubtitleExtension>('srt');
  const [state, setState] = useState<SearchState>(INITIAL_STATE);
  const sessionRef = useRef<SearchSession | null>(null);

  const request = useCallback(async (session: SearchSession, append = false) => {
    if (!session.active || session.pending || (append && !session.cursor)) return;
    session.pending = true;
    const cursor = append ? session.cursor : null;
    setState(previous => ({ ...previous, loading: true, error: false }));
    try {
      const data = await searchFiles({
        type: 'file',
        q: session.query.trim() || session.extension,
        cursor,
      });
      if (!session.active) return;
      const matches = data.files.filter(file =>
        file.filename.toLowerCase().endsWith(`.${session.extension}`),
      );
      // Never follow the folder cursor, or a cursor that failed to advance.
      session.cursor = data.nextFileCursor === cursor ? null : data.nextFileCursor;
      setState(previous => {
        const files = new Map((append ? previous.files : []).map(file => [file.id, file]));
        for (const file of matches) files.set(file.id, file);
        return { files: [...files.values()], loading: false, error: false, hasMore: !!session.cursor };
      });
    } catch {
      if (session.active) setState(previous => ({ ...previous, loading: false, error: true }));
    } finally {
      session.pending = false;
    }
  }, []);

  useEffect(() => {
    const session: SearchSession = { active: true, pending: false, query, extension, cursor: null };
    sessionRef.current = session;
    const timer = setTimeout(() => void request(session), SEARCH_DEBOUNCE_MS);
    return () => {
      session.active = false;
      clearTimeout(timer);
    };
  }, [query, extension, request]);

  const reset = () => {
    // Invalidate synchronously, before React commits new search inputs.
    if (sessionRef.current) sessionRef.current.active = false;
    setState(INITIAL_STATE);
  };

  return {
    ...state,
    query,
    extension,
    changeQuery: (value: string) => {
      if (value === query) return;
      reset();
      setQuery(value);
    },
    changeExtension: (value: SubtitleExtension) => {
      if (value === extension) return;
      reset();
      setExtension(value);
    },
    loadMore: () => {
      if (sessionRef.current) void request(sessionRef.current, true);
    },
    retry: () => {
      const session = sessionRef.current;
      if (session) void request(session, session.cursor !== null);
    },
  };
}
