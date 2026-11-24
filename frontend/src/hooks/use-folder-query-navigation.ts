'use client';

import { useCallback, useEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

const FOLDER_QUERY_PARAM = 'folder';

export function buildFolderHref(
  pathname: string,
  currentSearch: string | Pick<URLSearchParams, 'toString'>,
  folderId: string | undefined,
): string {
  const params = new URLSearchParams(
    typeof currentSearch === 'string' ? currentSearch : currentSearch.toString(),
  );
  const normalized = folderId?.trim() || undefined;
  if (normalized) {
    params.set(FOLDER_QUERY_PARAM, normalized);
  } else {
    params.delete(FOLDER_QUERY_PARAM);
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * Syncs the active folder ID with the `?folder=<id>` query parameter so browser
 * Back/Forward navigation and page reloads preserve folder location.
 */
export function useFolderQueryNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const searchQueryString = searchParams.toString();
  const rawFolderId = searchParams.get(FOLDER_QUERY_PARAM)?.trim();
  const currentFolderId = rawFolderId ? rawFolderId : undefined;

  const navStateRef = useRef({ router, pathname, searchQueryString, currentFolderId });
  useEffect(() => {
    navStateRef.current = { router, pathname, searchQueryString, currentFolderId };
  }, [router, pathname, searchQueryString, currentFolderId]);

  const navigateToFolder = useCallback((folderId: string | undefined) => {
    const state = navStateRef.current;
    const normalized = folderId?.trim() || undefined;
    if (normalized === state.currentFolderId) return;
    state.router.push(buildFolderHref(state.pathname, state.searchQueryString, normalized), {
      scroll: false,
    });
  }, []);

  const replaceFolder = useCallback((folderId: string | undefined) => {
    const state = navStateRef.current;
    const normalized = folderId?.trim() || undefined;
    if (normalized === state.currentFolderId) return;
    state.router.replace(buildFolderHref(state.pathname, state.searchQueryString, normalized), {
      scroll: false,
    });
  }, []);

  return { currentFolderId, navigateToFolder, replaceFolder };
}
