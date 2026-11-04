import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SharedPage from '@/app/shared/page';

const sharedState = vi.hoisted(() => ({
  fetchShared: vi.fn(),
  loadMoreShared: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock('@/hooks/use-require-auth', () => ({
  useRequireAuth: () => ({ isReady: true, token: 'token' }),
}));
vi.mock('@/providers/i18n-context', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      key === 'shared.items' ? `${vars?.count} items` : key,
  }),
}));
vi.mock('@/hooks/use-shared', () => ({
  useShared: () => ({
    folders: [],
    files: [],
    foldersHasMore: false,
    filesHasMore: true,
    totalFolders: 0,
    totalFiles: 1,
    loading: false,
    loadingMore: false,
    error: null,
    actionIds: new Set<string>(),
    ...sharedState,
  }),
}));
vi.mock('@/components/sidebar', () => ({ default: () => <aside /> }));
vi.mock('@/components/organisms/shared/shared-table', () => ({
  default: () => <div data-testid="shared-list" />,
}));

afterEach(cleanup);

describe('SharedPage', () => {
  it('uses server totals and keeps load-more available when the loaded page becomes empty', () => {
    render(<SharedPage />);

    expect(screen.getByText('1 items')).toBeTruthy();
    expect(screen.queryByText('shared.empty')).toBeNull();
    expect(screen.getByTestId('shared-list')).toBeTruthy();
    expect(screen.getByText('dashboard.loadMore')).toBeTruthy();
  });
});
