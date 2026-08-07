import {
  buildListPage,
  compareKeysByteOrder,
  decodeContinuationToken,
  encodeContinuationToken,
  MAX_CONTINUATION_KEY_LENGTH,
  S3ListObject,
} from './s3-list-pagination.util';

/**
 * Regression suite for the `aws s3 sync` re-transfer bug.
 *
 * The original failure was invisible to unit tests because every unit passed in
 * isolation: listing returned the right *set* of keys, just in ICU collation
 * order. `aws s3 sync` merge-joins the local file list (sorted by code point)
 * against the listing, so a locale-ordered response never pairs up and every
 * object looks missing at the destination forever. These tests therefore assert
 * ORDER and RESUME IDEMPOTENCY, not set membership.
 */

const obj = (key: string): S3ListObject => ({
  key,
  size: 1n,
  lastModified: new Date('2026-01-01T00:00:00.000Z'),
  etag: `"${key}"`,
});

const sortByteOrder = (keys: string[]) => [...keys].sort(compareKeysByteOrder);
const sortLocale = (keys: string[]) =>
  [...keys].sort((a, b) => a.localeCompare(b));

describe('compareKeysByteOrder', () => {
  it('orders uppercase before lowercase — the exact pair localeCompare gets wrong', () => {
    // This is the canary. `['a','Z'].sort(localeCompare)` yields ['a','Z'];
    // code-point order (what aws-cli uses locally) yields ['Z','a'].
    expect(sortByteOrder(['a', 'Z'])).toEqual(['Z', 'a']);

    // Prove the two orderings genuinely disagree here, so this test cannot
    // silently pass if the comparator is reverted to locale collation.
    expect(sortLocale(['a', 'Z'])).toEqual(['a', 'Z']);
    expect(sortByteOrder(['a', 'Z'])).not.toEqual(sortLocale(['a', 'Z']));
  });

  it('sorts every ASCII class by byte value: digits < uppercase < _ < lowercase', () => {
    // '-'(0x2D) '.'(0x2E) '1'(0x31) 'Z'(0x5A) '_'(0x5F) 'a'(0x61)
    expect(sortByteOrder(['a', '_x', 'Z', '1', '.', '-'])).toEqual([
      '-',
      '.',
      '1',
      'Z',
      '_x',
      'a',
    ]);
  });

  it('places multi-byte UTF-8 (Vietnamese diacritics) after all ASCII', () => {
    // 'đ' is U+0111 → 2 UTF-8 bytes starting 0xC4, above every ASCII byte.
    expect(sortByteOrder(['đôi bản nhạc chill.aep', 'z.txt', 'A.txt'])).toEqual(
      ['A.txt', 'z.txt', 'đôi bản nhạc chill.aep'],
    );

    // localeCompare folds 'đ' in next to 'd', i.e. before 'z' — divergent.
    expect(
      sortLocale(['đôi bản nhạc chill.aep', 'z.txt', 'A.txt']),
    ).not.toEqual(sortByteOrder(['đôi bản nhạc chill.aep', 'z.txt', 'A.txt']));
  });

  it('reproduces the live bucket key set in code-point order', () => {
    // Real keys taken from the failing bucket in the investigation report.
    const live = [
      'Render_2026-01-29_14-21.mp4',
      'RedGiantTrapcodeSuite14.1.0Winx64.zip',
      '[cnttqn.com]Adobe.zip',
      '1.29.rar',
      'đôi bản nhạc chill.aep',
      'a-lowercase.txt',
    ];

    // '1'(0x31) < 'R'(0x52) < '['(0x5B) < 'a'(0x61) < 'đ'(0xC4...)
    // and within the two 'Re' keys, 'd'(0x64) < 'n'(0x6E).
    expect(sortByteOrder(live)).toEqual([
      '1.29.rar',
      'RedGiantTrapcodeSuite14.1.0Winx64.zip',
      'Render_2026-01-29_14-21.mp4',
      '[cnttqn.com]Adobe.zip',
      'a-lowercase.txt',
      'đôi bản nhạc chill.aep',
    ]);

    // The whole point: ICU produces a different sequence for this exact input.
    expect(sortLocale(live)).not.toEqual(sortByteOrder(live));
  });

  it('returns 0 for identical keys and is antisymmetric', () => {
    expect(compareKeysByteOrder('a/b.txt', 'a/b.txt')).toBe(0);
    expect(compareKeysByteOrder('a', 'b')).toBeLessThan(0);
    expect(compareKeysByteOrder('b', 'a')).toBeGreaterThan(0);
  });

  it('sorts a prefix before the longer key that extends it', () => {
    // Matters for delimiter listings: 'docs/' must precede 'docs/a.txt'.
    expect(sortByteOrder(['docs/a.txt', 'docs/'])).toEqual([
      'docs/',
      'docs/a.txt',
    ]);
  });
});

describe('continuation token codec', () => {
  it('round-trips keys including multi-byte characters', () => {
    for (const key of ['a.txt', 'docs/đôi bản nhạc.aep', '[cnttqn.com]x.zip']) {
      expect(decodeContinuationToken(encodeContinuationToken(key))).toBe(key);
    }
  });

  it.each([
    ['empty token', ''],
    ['non-base64 characters', '!!!!'],
    ['whitespace inside the token', 'a b'],
    ['too much base64 padding', 'AAAA===='],
    ['decodes to a NUL byte', 'AA=='],
    ['decodes to invalid UTF-8 (replacement char)', '/w=='],
  ])('rejects a token with %s', (_label, token) => {
    expect(() => decodeContinuationToken(token)).toThrow('InvalidArgument');
  });

  it('rejects a raw token longer than the 2048-char cap', () => {
    expect(() => decodeContinuationToken('A'.repeat(2049))).toThrow(
      'InvalidArgument',
    );
  });

  it('rejects a token whose decoded key exceeds the key-length cap', () => {
    const tooLong = encodeContinuationToken(
      'k'.repeat(MAX_CONTINUATION_KEY_LENGTH + 1),
    );
    // Guard the premise: this must fail on decoded length, not the raw cap.
    expect(tooLong.length).toBeLessThanOrEqual(2048);
    expect(() => decodeContinuationToken(tooLong)).toThrow('InvalidArgument');
  });

  it('accepts a decoded key exactly at the cap', () => {
    const atCap = 'k'.repeat(MAX_CONTINUATION_KEY_LENGTH);
    expect(decodeContinuationToken(encodeContinuationToken(atCap))).toBe(atCap);
  });

  it('does not silently accept a forged token by dropping bad characters', () => {
    // Buffer.from(..., 'base64') is lenient and would decode this to something
    // plausible; the strict shape check must reject it instead.
    expect(() => decodeContinuationToken('YWJj$%^ZGVm')).toThrow(
      'InvalidArgument',
    );
  });
});

describe('buildListPage', () => {
  it('sorts before cutting the page, so page 1 holds the byte-order-lowest keys', () => {
    const page = buildListPage(
      [obj('a.txt'), obj('Z.txt'), obj('1.txt')],
      [],
      2,
    );
    expect(page.objects.map((o) => o.key)).toEqual(['1.txt', 'Z.txt']);
    expect(page.isTruncated).toBe(true);
  });

  it('interleaves objects and common prefixes in one ordered key space', () => {
    // Real S3 counts both toward MaxKeys and orders them together.
    const page = buildListPage([obj('b.txt'), obj('z.txt')], ['c/', 'a/'], 10);
    expect(page.objects.map((o) => o.key)).toEqual(['b.txt', 'z.txt']);
    expect(page.commonPrefixes).toEqual(['a/', 'c/']);
    expect(page.isTruncated).toBe(false);
  });

  it('counts common prefixes against maxKeys and can cut mid-prefix-list', () => {
    const page = buildListPage([obj('b.txt')], ['a/', 'c/'], 2);
    expect(page.commonPrefixes).toEqual(['a/']);
    expect(page.objects.map((o) => o.key)).toEqual(['b.txt']);
    expect(page.isTruncated).toBe(true);
    // Token must be the last key of the page overall — here the object, not 'a/'.
    expect(decodeContinuationToken(page.nextContinuationToken!)).toBe('b.txt');
  });

  it('paginates 2500 keys into exactly 3 pages with no loss and no duplicates', () => {
    // Deliberately generated so the *insertion* order differs from byte order
    // (zero-padded index reversed), forcing the sort to do real work.
    const all = Array.from({ length: 2500 }, (_, i) => {
      const n = String(2499 - i).padStart(5, '0');
      return obj(`${i % 3 === 0 ? 'Z' : 'a'}-file-${n}.bin`);
    });
    const expected = sortByteOrder(all.map((o) => o.key));

    const seen: string[] = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    let pages = 0;

    for (;;) {
      const page = buildListPage(all, [], 1000, cursor);
      pages += 1;
      seen.push(...page.objects.map((o) => o.key));
      pageSizes.push(page.objects.length);

      if (!page.isTruncated) {
        // Terminal page must carry no token, or clients loop forever.
        expect(page.nextContinuationToken).toBeUndefined();
        break;
      }
      expect(page.nextContinuationToken).toBeDefined();
      cursor = decodeContinuationToken(page.nextContinuationToken!);
      expect(pages).toBeLessThan(10); // fail loudly instead of hanging
    }

    expect(pages).toBe(3);
    expect(pageSizes).toEqual([1000, 1000, 500]);
    expect(seen).toHaveLength(2500);
    expect(new Set(seen).size).toBe(2500); // zero duplicates
    expect(seen).toEqual(expected); // exact union, in byte order
  });

  it('applies the cursor EXCLUSIVELY — boundary key is neither repeated nor skipped', () => {
    // The off-by-one this guards: a `>=` filter repeats the boundary key on the
    // next page; filtering by the wrong comparator skips keys entirely.
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const all = keys.map(obj);

    const first = buildListPage(all, [], 2);
    expect(first.objects.map((o) => o.key)).toEqual(['a', 'b']);
    const cursor = decodeContinuationToken(first.nextContinuationToken!);
    expect(cursor).toBe('b');

    const second = buildListPage(all, [], 2, cursor);
    // 'b' must NOT reappear, and 'c' must NOT be skipped.
    expect(second.objects.map((o) => o.key)).toEqual(['c', 'd']);
    expect(second.objects.map((o) => o.key)).not.toContain('b');
  });

  it('resumes correctly when the cursor key was deleted between pages', () => {
    // Key-based (not offset-based) resume: removing the boundary key must not
    // shift the window or skip its successor.
    const remaining = ['a', 'c', 'd'].map(obj);
    const page = buildListPage(remaining, [], 10, 'b');
    expect(page.objects.map((o) => o.key)).toEqual(['c', 'd']);
  });

  it('resumes across a multi-byte boundary key', () => {
    const all = ['a.txt', 'đôi bản nhạc chill.aep', 'z.txt'].map(obj);
    const first = buildListPage(all, [], 2);
    expect(first.objects.map((o) => o.key)).toEqual(['a.txt', 'z.txt']);
    const cursor = decodeContinuationToken(first.nextContinuationToken!);
    const second = buildListPage(all, [], 2, cursor);
    expect(second.objects.map((o) => o.key)).toEqual([
      'đôi bản nhạc chill.aep',
    ]);
    expect(second.isTruncated).toBe(false);
  });

  it('reports not-truncated with no token when the page exactly consumes the set', () => {
    const page = buildListPage(['a', 'b'].map(obj), [], 2);
    expect(page.objects).toHaveLength(2);
    expect(page.isTruncated).toBe(false);
    expect(page.nextContinuationToken).toBeUndefined();
  });

  it('returns an empty terminal page when the cursor is past the last key', () => {
    const page = buildListPage(['a', 'b'].map(obj), [], 10, 'z');
    expect(page.objects).toEqual([]);
    expect(page.commonPrefixes).toEqual([]);
    expect(page.isTruncated).toBe(false);
    expect(page.nextContinuationToken).toBeUndefined();
  });

  it('treats an empty-string cursor as no cursor', () => {
    const page = buildListPage(['a', 'b'].map(obj), [], 10, '');
    expect(page.objects.map((o) => o.key)).toEqual(['a', 'b']);
  });

  it('preserves object metadata through paging', () => {
    const page = buildListPage([obj('a.txt')], [], 10);
    expect(page.objects[0]).toEqual({
      key: 'a.txt',
      size: 1n,
      lastModified: new Date('2026-01-01T00:00:00.000Z'),
      etag: '"a.txt"',
    });
  });

  /**
   * Regression: an empty page reported `isTruncated: true` with NO
   * `nextContinuationToken` (the token is the last key of the page, and an empty
   * page has none). A client honoring IsTruncated re-requests with no cursor,
   * gets the same empty truncated page, and never advances — the same
   * client-stuck-in-a-loop failure class as the original ordering bug.
   *
   * Reachable via `max-keys=0` / `-5` / `abc` (parseInt → 0 / -5 / NaN).
   */
  describe('unresumable-page guard (maxKeys 0 / negative / NaN)', () => {
    it.each([
      ['zero', 0],
      ['negative', -5],
      ['NaN from a non-numeric max-keys', Number.NaN],
      ['negative infinity', Number.NEGATIVE_INFINITY],
    ])(
      'returns an empty NON-truncated page for a %s maxKeys',
      (_label, maxKeys) => {
        const page = buildListPage(['a', 'b', 'c'].map(obj), ['d/'], maxKeys);

        expect(page.objects).toEqual([]);
        expect(page.commonPrefixes).toEqual([]);
        // The bug: this was `true`, with no token to resume from.
        expect(page.isTruncated).toBe(false);
        expect(page.nextContinuationToken).toBeUndefined();
      },
    );

    it('never claims truncation without a cursor, for any maxKeys', () => {
      // Property check across the whole hostile range, including the fractional
      // and non-finite values parseInt/Math.min can leak through.
      const all = ['a', 'b', 'c', 'd'].map(obj);
      for (const maxKeys of [
        Number.NaN,
        Number.NEGATIVE_INFINITY,
        -100,
        -1,
        0,
        0.5,
        1,
        3,
        4,
        10,
        Number.POSITIVE_INFINITY,
      ]) {
        const page = buildListPage(all, ['z/'], maxKeys);
        if (page.isTruncated) {
          expect(page.nextContinuationToken).toBeDefined();
          // And the cursor must actually advance past something we returned.
          expect(
            page.objects.length + page.commonPrefixes.length,
          ).toBeGreaterThan(0);
        } else {
          expect(page.nextContinuationToken).toBeUndefined();
        }
      }
    });

    it('a maxKeys=0 page terminates the client loop instead of spinning', () => {
      // Simulates a client that trusts IsTruncated. Against the unfixed util
      // this loop never exits (cursor stays undefined forever) and trips the
      // iteration guard.
      const all = ['a', 'b', 'c'].map(obj);
      let cursor: string | undefined;
      let iterations = 0;

      for (;;) {
        const page = buildListPage(all, [], 0, cursor);
        iterations += 1;
        if (!page.isTruncated) break;
        expect(page.nextContinuationToken).toBeDefined();
        cursor = decodeContinuationToken(page.nextContinuationToken!);
        expect(iterations).toBeLessThan(5); // fail loudly instead of hanging
      }

      expect(iterations).toBe(1);
    });

    it('truncates a fractional maxKeys down instead of cutting a partial entry', () => {
      const page = buildListPage(['a', 'b', 'c'].map(obj), [], 2.7);
      expect(page.objects.map((o) => o.key)).toEqual(['a', 'b']);
      expect(page.isTruncated).toBe(true);
      expect(decodeContinuationToken(page.nextContinuationToken!)).toBe('b');
    });
  });
});
