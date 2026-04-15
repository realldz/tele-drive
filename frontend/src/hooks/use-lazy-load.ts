// DEPRECATED — Removed in favor of server-side pagination.
// This file is a no-op placeholder and will be deleted in a future cleanup.
export function useLazyLoad() {
  return { visibleCount: 0, hasMore: false, loadMoreRef: { current: null }, resetCount: () => {} };
}
