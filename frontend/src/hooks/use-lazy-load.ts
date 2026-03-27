'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface UseLazyLoadResult {
  visibleCount: number;
  hasMore: boolean;
  loadMoreRef: React.RefObject<HTMLDivElement | null>;
  resetCount: () => void;
}

/**
 * Shared hook for progressive / lazy loading via IntersectionObserver.
 * When the sentinel element scrolls into view, `visibleCount` increments
 * by `pageSize` so the caller can `.slice(0, visibleCount)`.
 */
export function useLazyLoad(totalItems: number, pageSize = 50): UseLazyLoadResult {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const hasMore = visibleCount < totalItems;

  const resetCount = useCallback(() => {
    setVisibleCount(pageSize);
  }, [pageSize]);

  useEffect(() => {
    if (!hasMore || !loadMoreRef.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisibleCount(prev => prev + pageSize);
      }
    });
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [hasMore, visibleCount, pageSize]);

  return { visibleCount, hasMore, loadMoreRef, resetCount };
}
