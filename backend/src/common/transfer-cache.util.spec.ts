import {
  clampTransferCacheTtl,
  computeTransferCacheHeaders,
  ifNoneMatchSatisfied,
  quantizeTokenExp,
  transferCacheETag,
} from './transfer-cache.util';

describe('transfer-cache.util', () => {
  describe('transferCacheETag', () => {
    it('is size-sensitive and deterministic', () => {
      expect(transferCacheETag('f1', 120n)).toBe(transferCacheETag('f1', 120));
      expect(transferCacheETag('f1', 120)).not.toBe(
        transferCacheETag('f1', 121),
      );
      expect(transferCacheETag('f1', 120)).not.toBe(
        transferCacheETag('f2', 120),
      );
    });

    it('is a quoted strong validator with td- prefix', () => {
      const etag = transferCacheETag('f1', 120);
      expect(etag).toMatch(/^"td-[0-9a-f]{32}"$/);
    });
  });

  describe('ifNoneMatchSatisfied', () => {
    const etag = transferCacheETag('f1', 120);

    it('matches exact and weak-prefixed validators', () => {
      const other = '"zzzz"';
      expect(ifNoneMatchSatisfied(etag, etag)).toBe(true);
      expect(ifNoneMatchSatisfied(`W/${etag}`, etag)).toBe(true);
      expect(ifNoneMatchSatisfied(`${other}, ${etag}`, etag)).toBe(true);
      expect(ifNoneMatchSatisfied('*', etag)).toBe(true);
      expect(ifNoneMatchSatisfied(other, etag)).toBe(false);
      expect(ifNoneMatchSatisfied(undefined, etag)).toBe(false);
      expect(ifNoneMatchSatisfied('', etag)).toBe(false);
    });
  });

  describe('computeTransferCacheHeaders', () => {
    it('private scope bypasses the CDN in every mode', () => {
      for (const mode of ['disabled', 'revalidate', 'full'] as const) {
        expect(
          computeTransferCacheHeaders(
            'private',
            { mode, ttlSeconds: 3600 },
            'f1',
            10n,
          ),
        ).toEqual({
          'Cache-Control': 'private, no-store',
          ETag: transferCacheETag('f1', 10n),
        });
      }
    });

    it('disabled mode still emits explicit no-store on signed routes', () => {
      expect(
        computeTransferCacheHeaders(
          'signed',
          { mode: 'disabled', ttlSeconds: 3600 },
          'f1',
          10n,
        ),
      ).toEqual({
        'Cache-Control': 'private, no-store',
        ETag: transferCacheETag('f1', 10n),
      });
    });

    it('revalidate → no-cache', () => {
      expect(
        computeTransferCacheHeaders(
          'signed',
          { mode: 'revalidate', ttlSeconds: 3600 },
          'f1',
          10n,
        )['Cache-Control'],
      ).toBe('no-cache');
    });

    it('full → public with clamped max-age', () => {
      const cc = (ttl: number) =>
        computeTransferCacheHeaders(
          'signed',
          { mode: 'full', ttlSeconds: ttl },
          'f1',
          10n,
        )['Cache-Control'];
      expect(cc(3600)).toBe('public, max-age=3600');
      expect(cc(1)).toBe('public, max-age=30');
      expect(cc(999999999)).toBe(`public, max-age=${7 * 24 * 60 * 60}`);
    });
  });

  describe('clampTransferCacheTtl', () => {
    it('falls back to 3600 on garbage, clamps the range', () => {
      expect(clampTransferCacheTtl(0)).toBe(3600);
      expect(clampTransferCacheTtl(Number.NaN)).toBe(3600);
      expect(clampTransferCacheTtl(10)).toBe(30);
      expect(clampTransferCacheTtl(10 ** 9)).toBe(7 * 24 * 60 * 60);
    });
  });
});

describe('quantizeTokenExp', () => {
  it('snaps exp up to the window bucket', () => {
    expect(quantizeTokenExp(1999, 1000)).toBe(2000);
    expect(quantizeTokenExp(2000, 1000)).toBe(2000);
    expect(quantizeTokenExp(2001, 1000)).toBe(3000);
  });

  it('passes through when the window is off', () => {
    expect(quantizeTokenExp(1999, 0)).toBe(1999);
    expect(quantizeTokenExp(1999, -5)).toBe(1999);
    expect(quantizeTokenExp(1999, Number.NaN)).toBe(1999);
  });
});
