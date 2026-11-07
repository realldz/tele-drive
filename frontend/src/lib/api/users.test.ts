import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api/client';
import { fetchCurrentUser } from '@/lib/api/users';

vi.mock('@/lib/api/client', () => ({
  api: { get: vi.fn() },
}));

describe('fetchCurrentUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.get).mockResolvedValue({ data: {} });
  });

  it('supports a background quota refresh without the global overlay', async () => {
    await fetchCurrentUser(true);

    expect(api.get).toHaveBeenCalledWith('/users/me', {
      skipRequestOverlay: true,
    });
  });
});
