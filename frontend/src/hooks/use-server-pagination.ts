import { useState, useRef, useCallback, useEffect } from 'react';

interface UseServerPaginationOptions<T> {
  fetchFn: (cursor?: string, search?: string) => Promise<{
    data: T[];
    nextCursor: string | null;
    total: number;
  }>;
  enabled?: boolean;
  limit?: number;
}

interface UseServerPaginationResult<T> {
  data: T[];
  loading: boolean;
  loadingMore: boolean;
  hasNext: boolean;
  total: number;
  loadMoreRef: React.RefObject<HTMLDivElement | null>;
  reset: () => void;
  setSearch: (search: string) => void;
}

export function useServerPagination<T>(
  options: UseServerPaginationOptions<T>,
): UseServerPaginationResult<T> {
  const { fetchFn, enabled = true, limit = 50 } = options;

  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasNext, setHasNext] = useState(true);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');

  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const fetchRef = useRef<typeof fetchFn>(fetchFn);

  fetchRef.current = fetchFn;

  const fetchPage = useCallback(
    async (nextCursor?: string, isRefresh = false) => {
      try {
        if (isRefresh) {
          setLoading(true);
        } else {
          setLoadingMore(true);
        }
        const result = await fetchRef.current(nextCursor, search || undefined);
        setData((prev) => (isRefresh ? result.data : [...prev, ...result.data]));
        setHasNext(result.nextCursor !== null);
        setCursor(result.nextCursor || undefined);
        setTotal(result.total);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [search],
  );

  // Fetch first page when enabled or search changes
  useEffect(() => {
    if (!enabled) return;
    setData([]);
    setCursor(undefined);
    setHasNext(true);
    fetchPage(undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, search]);

  // Fetch next page
  const fetchNextPage = useCallback(() => {
    if (!hasNext || loading || loadingMore) return;
    fetchPage(cursor);
  }, [hasNext, cursor, loading, loadingMore, fetchPage]);

  // Setup IntersectionObserver for infinite scroll
  useEffect(() => {
    if (observerRef.current) observerRef.current.disconnect();

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNext && !loading && !loadingMore) {
          fetchNextPage();
        }
      },
      { rootMargin: '200px' },
    );

    const current = sentinelRef.current;
    if (current) observerRef.current.observe(current);

    return () => {
      if (observerRef.current) observerRef.current.disconnect();
    };
  }, [fetchNextPage, hasNext, loading, loadingMore]);

  const reset = useCallback(() => {
    setData([]);
    setCursor(undefined);
    setHasNext(true);
    fetchPage(undefined, true);
  }, [fetchPage]);

  const setSearchWithReset = useCallback(
    (value: string) => {
      setSearch(value);
    },
    [],
  );

  return {
    data,
    loading,
    loadingMore,
    hasNext,
    total,
    loadMoreRef: sentinelRef as React.RefObject<HTMLDivElement | null>,
    reset,
    setSearch: setSearchWithReset,
  };
}
