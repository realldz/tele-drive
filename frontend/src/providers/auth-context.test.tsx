import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '@/providers/auth-context';

vi.mock('@/lib/api', () => {
  const instance = () => ({
    defaults: { headers: { common: {} as Record<string, string> } },
    interceptors: {
      request: { use: vi.fn(() => 0), eject: vi.fn() },
      response: { use: vi.fn(() => 0), eject: vi.fn() },
    },
    post: vi.fn(),
  });
  return {
    api: instance(),
    transferApi: instance(),
    fetchCurrentUser: vi.fn(),
    clearStreamCookie: vi.fn(() => Promise.resolve()),
  };
});

function AuthProbe() {
  const { isLoading, token, user } = useAuth();
  return <div data-testid="auth-state">{`${isLoading ? 'loading' : 'ready'}:${token ?? 'none'}:${user?.username ?? 'none'}`}</div>;
}

describe('AuthProvider cache restoration', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

  it('clears malformed cached user JSON and completes loading', async () => {
    localStorage.setItem('token', 'stale-token');
    localStorage.setItem('user', '{broken-json');

    render(<AuthProvider><AuthProbe /></AuthProvider>);

    await waitFor(() => expect(screen.getByTestId('auth-state').textContent).toBe('ready:none:none'));
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
  });

  it('rejects an incomplete cached user object', async () => {
    localStorage.setItem('token', 'stale-token');
    localStorage.setItem('user', JSON.stringify({ id: 'user-1' }));

    render(<AuthProvider><AuthProbe /></AuthProvider>);

    await waitFor(() => expect(screen.getByTestId('auth-state').textContent).toBe('ready:none:none'));
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
  });

  it('completes loading when browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError');
    });

    render(<AuthProvider><AuthProbe /></AuthProvider>);

    await waitFor(() => expect(screen.getByTestId('auth-state').textContent).toBe('ready:none:none'));
  });
});
