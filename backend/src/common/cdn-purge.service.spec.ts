import { CdnPurgeService } from './cdn-purge.service';

/** Shape of the mocked fetch init arg we care about in these tests. */
interface MockRequestInit {
  headers?: { Authorization?: string };
  body?: string;
}

const callInit = (fetchMock: jest.Mock, i: number): MockRequestInit =>
  (fetchMock.mock.calls[i] as unknown[])[1] as MockRequestInit;

/**
 * Unit tests capture the fetch mock. Reset relevant env vars per test —
 * CdnPurgeService reads them in its constructor.
 */
describe('CdnPurgeService', () => {
  let fetchMock: jest.Mock;

  const envKeys = [
    'CDN_PURGE_PROVIDER',
    'CLOUDFLARE_API_TOKEN',
    'CDN_CACHE_PURGE_ZONE',
    'CDN_CACHE_PURGE_BASE',
    'PUBLIC_TRANSFER_URL',
  ];
  const envSnapshot: Record<string, string | undefined> = {};
  for (const key of envKeys) envSnapshot[key] = process.env[key];

  const applyEnv = (env: Record<string, string | undefined>) => {
    for (const key of envKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  };

  const restoreEnv = () => {
    for (const key of envKeys) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
  };

  const withEnv = async (
    env: Record<string, string | undefined>,
    fn: () => void | Promise<void>,
  ) => {
    applyEnv(env);
    try {
      await fn();
    } finally {
      restoreEnv();
    }
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    restoreEnv();
  });

  it('is a no-op with the default provider', async () => {
    await withEnv({ CDN_PURGE_PROVIDER: 'none' }, async () => {
      const svc = new CdnPurgeService();
      await svc.purgeDeletedFiles([{ id: 'f1', shareToken: 'tok1' }]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(svc.purgeProviders()).toBe('none');
    });
  });

  it('skips when no share tokens exist', async () => {
    await withEnv(
      {
        CDN_PURGE_PROVIDER: 'cloudflare',
        CDN_CACHE_PURGE_BASE: 'https://cdn.example.com',
      },
      async () => {
        const svc = new CdnPurgeService();
        await svc.purgeDeletedFiles([{ id: 'f1' }, { id: 'f2' }]);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );
  });

  it('purges all three shared routes with a normalized base', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    await withEnv(
      {
        CDN_PURGE_PROVIDER: 'cloudflare',
        CLOUDFLARE_API_TOKEN: 'tok',
        CDN_CACHE_PURGE_ZONE: 'zone1',
        CDN_CACHE_PURGE_BASE: 'https://cdn.example.com///',
      },
      async () => {
        const svc = new CdnPurgeService();
        await svc.purgeDeletedFiles([{ id: 'f1', shareToken: 'tok1' }]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url] = fetchMock.mock.calls[0] as [string, unknown];
        expect(url).toBe(
          'https://api.cloudflare.com/client/v4/zones/zone1/purge_cache',
        );
        expect(callInit(fetchMock, 0).headers?.Authorization).toBe(
          'Bearer tok',
        );
        const body = JSON.parse(callInit(fetchMock, 0).body ?? '{}') as {
          files: string[];
        };
        expect(body.files).toEqual([
          'https://cdn.example.com/files/share/tok1/download',
          'https://cdn.example.com/files/share/tok1/stream',
          'https://cdn.example.com/files/share/stream/tok1',
        ]);
      },
    );
  });

  it('warns and skips the HTTP call when the base URL is unknown', async () => {
    await withEnv(
      { CDN_PURGE_PROVIDER: 'cloudflare', PUBLIC_TRANSFER_URL: '' },
      async () => {
        const svc = new CdnPurgeService();
        await svc.purgeDeletedFiles([{ id: 'f1', shareToken: 'tok1' }]);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );
  });

  it('reads the base from PUBLIC_TRANSFER_URL when CDN_CACHE_PURGE_BASE is unset', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    await withEnv(
      {
        CDN_PURGE_PROVIDER: 'cloudflare',
        CLOUDFLARE_API_TOKEN: 'tok',
        CDN_CACHE_PURGE_ZONE: 'zone1',
        PUBLIC_TRANSFER_URL: 'https://transfer.example.com',
      },
      async () => {
        const svc = new CdnPurgeService();
        await svc.purgeDeletedFiles([{ id: 'f1', shareToken: 'tok1' }]);
        const body = JSON.parse(callInit(fetchMock, 0).body ?? '{}') as {
          files: string[];
        };
        expect(body.files[0]).toBe(
          'https://transfer.example.com/files/share/tok1/download',
        );
      },
    );
  });

  it('keeps each Cloudflare call within the 30-URL limit', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    await withEnv(
      {
        CDN_PURGE_PROVIDER: 'cloudflare',
        CLOUDFLARE_API_TOKEN: 'tok',
        CDN_CACHE_PURGE_ZONE: 'zone1',
        PUBLIC_TRANSFER_URL: 'https://transfer.example.com',
      },
      async () => {
        const svc = new CdnPurgeService();
        const files = Array.from({ length: 10 }, (_, i) => ({
          id: `f${i}`,
          shareToken: `t${i}`,
        }));
        await svc.purgeDeletedFiles(files);
        // 10 tokens × 3 URLs = 30 → exactly one batch
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );
  });

  it('never throws on a failed purge response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"success":false}'),
    });
    await withEnv(
      {
        CDN_PURGE_PROVIDER: 'cloudflare',
        CLOUDFLARE_API_TOKEN: 'tok',
        CDN_CACHE_PURGE_ZONE: 'zone1',
        PUBLIC_TRANSFER_URL: 'https://transfer.example.com',
      },
      async () => {
        const svc = new CdnPurgeService();
        await expect(
          svc.purgeDeletedFiles([{ id: 'f1', shareToken: 't1' }]),
        ).resolves.toBeUndefined();
      },
    );
  });

  it('never throws on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await withEnv(
      {
        CDN_PURGE_PROVIDER: 'cloudflare',
        CLOUDFLARE_API_TOKEN: 'tok',
        CDN_CACHE_PURGE_ZONE: 'zone1',
        PUBLIC_TRANSFER_URL: 'https://transfer.example.com',
      },
      async () => {
        const svc = new CdnPurgeService();
        await expect(
          svc.purgeDeletedFiles([{ id: 'f1', shareToken: 't1' }]),
        ).resolves.toBeUndefined();
      },
    );
  });
});
