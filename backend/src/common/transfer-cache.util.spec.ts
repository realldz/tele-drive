import {
  clampTransferCacheTtl,
  computeTransferCacheHeaders,
  ifNoneMatchSatisfied,
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
      expect(ifNoneMatchSatisfied(etag, etag)).toBe(true);
      expect(ifNoneMatchSatisfied(`W/${etag}`, etag)).toBe(true);
    });

    it('matches comma lists and the * wildcard', () => {
      const other = '"zzzz"';
      expect(ifNoneMatchSatisfied(`${other}, ${etag}`, etag)).toBe(true);
      expect(ifNoneMatchSatisfied('*', etag)).toBe(true);
      expect(ifNoneMatchSatisfied(other, etag)).toBe(false);
    });

    it('is false without a header', () => {
      expect(ifNoneMatchSatisfied(undefined, etag)).toBe(false);
      expect(ifNoneMatchSatisfied('', etag)).toBe(false);
    });
  });

  describe('computeTransferCacheHeaders', () => {
    it('private scope bypasses the CDN regardless of settings', () => {
      const dirs = { enabled: true, ttlSeconds: 3600 };
      expect(computeTransferCacheHeaders('private', dirs, 'f1', 10n)).toEqual({
        'Cache-Control': 'private, no-store',
        ETag: transferCacheETag('f1', 10n),
      });
    });

    it('disabled settings still emit explicit no-store on signed routes', () => {
      const dirs = { enabled: false, ttlSeconds: 3600 };
      expect(computeTransferCacheHeaders('signed', dirs, 'f1', 10n)).toEqual({
        'Cache-Control': 'private, no-store',
        ETag: transferCacheETag('f1', 10n),
      });
    });

    it('enabled + signed → public with clamped max-age', () => {
      expect(
        computeTransferCacheHeaders(
          'signed',
          { enabled: true, ttlSeconds: 3600 },
          'f1',
          10n,
        )['Cache-Control'],
      ).toBe('public, max-age=3600');
      expect(
        computeTransferCacheHeaders(
          'signed',
          { enabled: true, ttlSeconds: 1 },
          'f1',
          10n,
        )['Cache-Control'],
      ).toBe('public, max-age=30');
      expect(
        computeTransferCacheHeaders(
          'signed',
          { enabled: true, ttlSeconds: 999999999 },
          'f1',
          10n,
        )['Cache-Control'],
      ).toBe(`public, max-age=${7 * 24 * 60 * 60}`);
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
