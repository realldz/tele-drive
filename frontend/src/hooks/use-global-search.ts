'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { searchFiles } from '@/lib/api';
import {
  LOAD_MORE_ROOT_MARGIN,
  SEARCH_DEBOUNCE_MS,
  SEARCH_TIME_PRESETS,
} from '@/lib/constants';
import type {
  SearchTypeFilter,
  SearchTimePresetKey,
} from '@/lib/constants';
import type { SortField, SortDirection } from '@/hooks/use-folder-content';
import type { FileRecord, FolderRecord } from '@/lib/types';

export interface SearchFilters {
  type: SearchTypeFilter;
  format: string | null;
  timePreset: SearchTimePresetKey;
  customFrom: string | null; // ISO date (yyyy-mm-dd)
  customTo: string | null;
}

const DEFAULT_FILTERS: SearchFilters = {
  type: 'all',
  format: null,
  timePreset: 'all',
  customFrom: null,
  customTo: null,
};

/** Resolve the active time range → {createdFrom, createdTo} ISO strings. */
function resolveRange(f: SearchFilters): { createdFrom?: string; createdTo?: string } {
  // Custom range wins over preset when either bound is set.
  if (f.customFrom || f.customTo) {
    // Both bounds parsed as LOCAL time (no trailing Z) so a day-range doesn't
    // skew by the tz offset near midnight.
    return {
      createdFrom: f.customFrom ? new Date(`${f.customFrom}T00:00:00`).toISOString() : undefined,
      createdTo: f.customTo ? new Date(`${f.customTo}T23:59:59.999`).toISOString() : undefined,
    };
  }
  const preset = SEARCH_TIME_PRESETS.find(p => p.key === f.timePreset);
  if (!preset || preset.days === null) return {};
  const from = new Date();
  from.setDate(from.getDate() - preset.days);
  return { createdFrom: from.toISOString() };
}

/**
 * Global-search data path — sibling to useFolderContent. Owns its own query,
 * filters, dual cursors, and results so folder-browse cursors never tangle with
 * search cursors (per CLAUDE.md: separate cursors per view). page.tsx switches
 * which dataset renders based on `searchActive`.
 */
export function useGlobalSearch(
  token: string | null,
  sortField: SortField,
  sortDirection: SortDirection,
) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS);

  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadMore, setIsLoadMore] = useState(false);
  const [hasMoreFolders, setHasMoreFolders] = useState(false);
  const [hasMoreFiles, setHasMoreFiles] = useState(false);
  const [totalFolders, setTotalFolders] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);

  const nextFolderCursor = useRef<string | null>(null);
  const nextFileCursor = useRef<string | null>(null);
  // Monotonic request id — guards against out-of-order responses landing after
  // a newer query/filter change.
  const requestSeq = useRef(0);

  const filtersActive = useMemo(
    () =>
      filters.type !== 'all' ||
      filters.format !== null ||
      filters.timePreset !== 'all' ||
      filters.customFrom !== null ||
      filters.customTo !== null,
    [filters],
  );

  const searchActive = query.trim().length > 0 || filtersActive;

  const hasMore = hasMoreFolders || hasMoreFiles;
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const runSearch = useCallback(
    async (isLoadMoreCall: boolean) => {
      if (!token || !searchActive) return;
      const seq = ++requestSeq.current;
      if (isLoadMoreCall) setIsLoadMore(true);
      else setIsSearching(true);

      const range = resolveRange(filters);
      try {
        const data = await searchFiles({
          q: query.trim() || undefined,
          type: filters.type,
          format: filters.format || undefined,
          createdFrom: range.createdFrom,
          createdTo: range.createdTo,
          cursor: isLoadMoreCall ? (nextFolderCursor.current ?? nextFileCursor.current) : undefined,
          sortField,
          sortDirection,
        });
        // Drop stale response (a newer request superseded this one).
        if (seq !== requestSeq.current) return;

        if (isLoadMoreCall) {
          setFolders(prev => {
            const seen = new Set(prev.map(f => f.id));
            return [...prev, ...data.folders.filter(f => !seen.has(f.id))];
          });
          setFiles(prev => {
            const seen = new Set(prev.map(f => f.id));
            return [...prev, ...data.files.filter(f => !seen.has(f.id))];
          });
        } else {
          setFolders(data.folders);
          setFiles(data.files);
        }
        setHasMoreFolders(data.nextFolderCursor !== null);
        setHasMoreFiles(data.nextFileCursor !== null);
        setTotalFolders(data.totalFolders);
        setTotalFiles(data.totalFiles);
        nextFolderCursor.current = data.nextFolderCursor;
        nextFileCursor.current = data.nextFileCursor;
      } catch {
        // 401 handled by axios interceptor; other errors leave prior results.
      } finally {
        if (seq === requestSeq.current) {
          setIsSearching(false);
          setIsLoadMore(false);
        }
      }
    },
    [token, searchActive, query, filters, sortField, sortDirection],
  );

  // Debounced initial fetch on any query/filter/sort change.
  useEffect(() => {
    if (!searchActive) {
      // Cleared → drop results so browse mode shows through.
      setFolders([]);
      setFiles([]);
      setHasMoreFolders(false);
      setHasMoreFiles(false);
      setTotalFolders(0);
      setTotalFiles(0);
      setIsSearching(false);
      setIsLoadMore(false);
      nextFolderCursor.current = null;
      nextFileCursor.current = null;
      requestSeq.current++; // invalidate any in-flight response
      return;
    }
    const id = setTimeout(() => runSearch(false), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchActive, runSearch]);

  const handleLoadMore = useCallback(() => {
    runSearch(true);
  }, [runSearch]);

  useEffect(() => {
    if (!loadMoreRef.current) return;
    if (observerRef.current) observerRef.current.disconnect();
    observerRef.current = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && hasMore && !isSearching && !isLoadMore) {
          handleLoadMore();
        }
      },
      { rootMargin: LOAD_MORE_ROOT_MARGIN },
    );
    observerRef.current.observe(loadMoreRef.current);
    return () => { if (observerRef.current) observerRef.current.disconnect(); };
  }, [hasMore, isSearching, isLoadMore, handleLoadMore]);

  const clearSearch = useCallback(() => {
    setQuery('');
    setFilters(DEFAULT_FILTERS);
  }, []);

  const orderedIds = useMemo(
    () => [...folders.map(f => f.id), ...files.map(f => f.id)],
    [folders, files],
  );

  return {
    query, setQuery,
    filters, setFilters,
    filtersActive, searchActive,
    folders, files, orderedIds,
    isSearching, hasMore, loadMoreRef,
    totalFolders, totalFiles,
    clearSearch,
  };
}
