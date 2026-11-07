import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api/client';
import { abortUpload } from '@/lib/api/files';

vi.mock('@/lib/api/client', () => ({
  api: { post: vi.fn() },
}));

describe('abortUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.post).mockResolvedValue({ data: {} });
  });

  it('can abort a background upload without the global overlay', async () => {
    await abortUpload('file-id', true);

    expect(api.post).toHaveBeenCalledWith(
      '/transfer/upload/file-id/abort',
      undefined,
      { skipRequestOverlay: true },
    );
  });
});
