import { S3Controller } from './s3.controller';
import { encodeContinuationToken } from './s3-list-pagination.util';

describe('S3Controller', () => {
  const createController = (overrides: Record<string, unknown> = {}) => {
    const s3Service = {
      buildErrorXml: jest.fn((code: string, message: string) => {
        return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
      }),
      ...overrides,
    };

    const controller = new S3Controller(
      s3Service as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const res = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      end: jest.fn().mockReturnThis(),
    };

    return { controller, s3Service, res };
  };

  /** Minimal authenticated request stub for the listing handler. */
  const listRequest = (query: Record<string, string>) =>
    ({ s3UserId: 'user-1', query }) as never;

  /** Invoke the private error renderer without leaking `any` into the suite. */
  const sendS3Error = (
    controller: S3Controller,
    res: unknown,
    err: unknown,
  ): void =>
    (
      controller as unknown as {
        sendS3Error: (res: unknown, err: unknown) => void;
      }
    ).sendS3Error(res, err);

  it('maps retryable upstream errors to ServiceUnavailable', () => {
    const { controller, s3Service, res } = createController();
    const err = new Error(
      'request to http://nginx:8088/bot123/sendDocument failed, reason: socket hang up',
    );

    sendS3Error(controller, res, err);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(s3Service.buildErrorXml).toHaveBeenCalledWith(
      'ServiceUnavailable',
      'A temporary upstream error occurred. Please retry.',
    );
  });

  it('preserves mapped S3 domain errors', () => {
    const { controller, s3Service, res } = createController();
    const err = new Error('NoSuchKey');

    sendS3Error(controller, res, err);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(s3Service.buildErrorXml).toHaveBeenCalledWith(
      'NoSuchKey',
      'NoSuchKey',
    );
  });

  describe('ListObjectsV2 continuation-token plumbing', () => {
    const emptyPage = {
      objects: [],
      commonPrefixes: [],
      isTruncated: false,
      nextContinuationToken: undefined,
    };

    const listController = () => {
      const listObjects = jest
        .fn<Promise<unknown>, unknown[]>()
        .mockResolvedValue(emptyPage);
      const buildListObjectsV2Xml = jest
        .fn<string, unknown[]>()
        .mockReturnValue('<xml/>');
      const ctx = createController({ listObjects, buildListObjectsV2Xml });
      return { ...ctx, listObjects, buildListObjectsV2Xml };
    };

    /** The `startAfter` argument S3Service.listObjects was called with. */
    const startAfterArg = (
      listObjects: jest.Mock<unknown, unknown[]>,
    ): unknown => listObjects.mock.calls[0][5];

    /** The `cursors` argument (9th param) buildListObjectsV2Xml received. */
    const cursorsArg = (buildXml: jest.Mock<unknown, unknown[]>): unknown =>
      buildXml.mock.calls[0][8];

    it('decodes a valid continuation token into the exclusive startAfter key', async () => {
      const { controller, res, listObjects } = listController();
      const token = encodeContinuationToken('docs/đôi bản nhạc.aep');

      await controller.listObjects(
        'bucket-a',
        listRequest({ 'continuation-token': token }),
        res as never,
      );

      expect(listObjects).toHaveBeenCalledWith(
        'user-1',
        'bucket-a',
        '',
        undefined,
        1000,
        'docs/đôi bản nhạc.aep',
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('lets a continuation token win over start-after (AWS precedence)', async () => {
      const { controller, res, listObjects } = listController();

      await controller.listObjects(
        'bucket-a',
        listRequest({
          'continuation-token': encodeContinuationToken('from-token.txt'),
          'start-after': 'from-start-after.txt',
        }),
        res as never,
      );

      expect(startAfterArg(listObjects)).toBe('from-token.txt');
    });

    it('uses start-after when no continuation token is present', async () => {
      const { controller, res, listObjects } = listController();

      await controller.listObjects(
        'bucket-a',
        listRequest({ 'start-after': 'a.txt' }),
        res as never,
      );

      expect(startAfterArg(listObjects)).toBe('a.txt');
    });

    it.each([
      ['non-base64 characters', '!!!!'],
      ['whitespace', 'a b'],
      ['excess padding', 'AAAA===='],
      ['a NUL byte', 'AA=='],
      ['invalid UTF-8', '/w=='],
      ['an over-long raw token', 'A'.repeat(2049)],
    ])(
      'rejects a continuation token with %s as InvalidArgument without listing',
      async (_label, token) => {
        const { controller, res, listObjects } = listController();

        await controller.listObjects(
          'bucket-a',
          listRequest({ 'continuation-token': token }),
          res as never,
        );

        expect(res.status).toHaveBeenCalledWith(400);
        // The listing must not run at all for a forged cursor.
        expect(listObjects).not.toHaveBeenCalled();
      },
    );

    it('rejects an over-long start-after without listing', async () => {
      const { controller, res, listObjects } = listController();

      await controller.listObjects(
        'bucket-a',
        listRequest({ 'start-after': 'k'.repeat(1025) }),
        res as never,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(listObjects).not.toHaveBeenCalled();
    });

    it('echoes the client cursors and the next token into the XML builder', async () => {
      const listObjects = jest.fn().mockResolvedValue({
        objects: [],
        commonPrefixes: [],
        isTruncated: true,
        nextContinuationToken: 'bmV4dC50eHQ=',
      });
      const buildListObjectsV2Xml = jest
        .fn<string, unknown[]>()
        .mockReturnValue('<xml/>');
      const { controller, res } = createController({
        listObjects,
        buildListObjectsV2Xml,
      });
      const token = encodeContinuationToken('a.txt');

      await controller.listObjects(
        'bucket-a',
        listRequest({ 'continuation-token': token, 'start-after': 'ignored' }),
        res as never,
      );

      expect(cursorsArg(buildListObjectsV2Xml)).toEqual({
        nextContinuationToken: 'bmV4dC50eHQ=',
        continuationToken: token,
        startAfter: 'ignored',
      });
    });

    it('passes no cursor at all when the client supplies neither', async () => {
      const { controller, res, listObjects } = listController();

      await controller.listObjects('bucket-a', listRequest({}), res as never);

      expect(startAfterArg(listObjects)).toBeUndefined();
    });
  });

  /**
   * Regression: `Math.min(parseInt(max-keys || '1000', 10), 1000)` turned '0'
   * into 0, '-5' into -5 and 'abc' into NaN, all of which reached buildListPage
   * and produced an empty page flagged truncated with no continuation token —
   * an unresumable page that loops an IsTruncated-honoring client forever.
   */
  describe('max-keys sanitization', () => {
    const maxKeysArg = (listObjects: jest.Mock<unknown, unknown[]>): unknown =>
      listObjects.mock.calls[0][4];

    const listController = () => {
      const listObjects = jest
        .fn<Promise<unknown>, unknown[]>()
        .mockResolvedValue({
          objects: [],
          commonPrefixes: [],
          isTruncated: false,
          nextContinuationToken: undefined,
        });
      const buildListObjectsV2Xml = jest
        .fn<string, unknown[]>()
        .mockReturnValue('<xml/>');
      const ctx = createController({ listObjects, buildListObjectsV2Xml });
      return { ...ctx, listObjects, buildListObjectsV2Xml };
    };

    it.each([
      ['a negative max-keys', '-5'],
      ['a non-numeric max-keys', 'abc'],
      ['a partially numeric max-keys', '12abc'],
      ['a float max-keys', '1.5'],
      ['a whitespace-only max-keys', '   '],
    ])('rejects %s with InvalidArgument and does not list', async (_l, raw) => {
      const { controller, res, listObjects, s3Service } = listController();

      await controller.listObjects(
        'bucket-a',
        listRequest({ 'max-keys': raw }),
        res as never,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(listObjects).not.toHaveBeenCalled();
      // Body must be a real S3 code, not "[object Object]".
      expect(s3Service.buildErrorXml).toHaveBeenCalledWith(
        'InvalidArgument',
        'InvalidArgument',
      );
    });

    it('accepts max-keys=0 as a legal empty listing (real S3 behavior)', async () => {
      const { controller, res, listObjects } = listController();

      await controller.listObjects(
        'bucket-a',
        listRequest({ 'max-keys': '0' }),
        res as never,
      );

      expect(res.status).toHaveBeenCalledWith(200);
      expect(maxKeysArg(listObjects)).toBe(0);
    });

    it.each([
      ['absent', undefined, 1000],
      ['empty', '', 1000],
      ['in range', '250', 250],
      ['above the cap', '5000', 1000],
      ['exactly the cap', '1000', 1000],
    ])('maps a %s max-keys to %s', async (_l, raw, expected) => {
      const { controller, res, listObjects } = listController();

      await controller.listObjects(
        'bucket-a',
        listRequest(raw === undefined ? {} : { 'max-keys': raw }),
        res as never,
      );

      expect(res.status).toHaveBeenCalledWith(200);
      expect(maxKeysArg(listObjects)).toBe(expected);
    });
  });

  /**
   * Regression: call sites raise plain `{ status, message }` literals. The old
   * `String(err)` fallback rendered them as `<Code>[object Object]</Code>` — the
   * status was right but the body was unparseable by any S3 client.
   */
  describe('sendS3Error with plain object errors', () => {
    it('reads Code/Message off a plain { status, message } literal', () => {
      const { controller, s3Service, res } = createController();

      sendS3Error(controller, res, {
        status: 400,
        message: 'InvalidArgument',
      });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(s3Service.buildErrorXml).toHaveBeenCalledWith(
        'InvalidArgument',
        'InvalidArgument',
      );
      expect(s3Service.buildErrorXml.mock.calls[0][0]).not.toBe(
        '[object Object]',
      );
    });

    it('derives the status from the code when a plain object omits status', () => {
      const { controller, s3Service, res } = createController();

      sendS3Error(controller, res, { message: 'NoSuchKey' });

      expect(res.status).toHaveBeenCalledWith(404);
      expect(s3Service.buildErrorXml).toHaveBeenCalledWith(
        'NoSuchKey',
        'NoSuchKey',
      );
    });

    it('still falls back to InternalError for a non-Error with no message', () => {
      const { controller, s3Service, res } = createController();

      sendS3Error(controller, res, {});

      expect(res.status).toHaveBeenCalledWith(500);
      expect(s3Service.buildErrorXml).toHaveBeenCalledWith(
        'InternalError',
        'An internal error occurred.',
      );
    });

    it('a malformed continuation token yields a parseable InvalidArgument body', async () => {
      const listObjects = jest.fn();
      const { controller, s3Service, res } = createController({
        listObjects,
        buildListObjectsV2Xml: jest.fn().mockReturnValue('<xml/>'),
      });

      await controller.listObjects(
        'bucket-a',
        listRequest({ 'continuation-token': '!!!!' }),
        res as never,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(listObjects).not.toHaveBeenCalled();
      expect(s3Service.buildErrorXml).toHaveBeenCalledWith(
        'InvalidArgument',
        'InvalidArgument',
      );
      const xml: string = s3Service.buildErrorXml.mock.results[0]
        .value as string;
      expect(xml).toContain('<Code>InvalidArgument</Code>');
      expect(xml).not.toContain('[object Object]');
    });
  });

  describe('LastModified stability', () => {
    it('HEAD reports createdAt, matching what List emits for the same object', async () => {
      const createdAt = new Date('2026-01-05T10:00:00.000Z');
      // updatedAt is deliberately later: it is Prisma @updatedAt and advances on
      // every read-path counter write, so it must never back LastModified.
      const file = {
        id: 'file-1',
        createdAt,
        updatedAt: new Date('2026-07-30T23:59:00.000Z'),
        size: 10n,
        etag: '"e1"',
        mimeType: 'text/plain',
      };
      const { controller, res } = createController({
        findObject: jest.fn().mockResolvedValue(file),
      });

      await controller.headObject(
        'bucket-a',
        { key: 'a.txt' },
        { s3UserId: 'user-1', query: {} } as never,
        res as never,
      );

      expect(res.setHeader).toHaveBeenCalledWith(
        'Last-Modified',
        createdAt.toUTCString(),
      );
      expect(res.setHeader).not.toHaveBeenCalledWith(
        'Last-Modified',
        file.updatedAt.toUTCString(),
      );

      // List renders the same instant from the same field; sync compares these
      // two values, so any divergence re-transfers the object forever.
      const listLastModified = file.createdAt.toISOString();
      expect(new Date(listLastModified).toUTCString()).toBe(
        createdAt.toUTCString(),
      );
    });

    it('does not advance LastModified when the object is read repeatedly', async () => {
      const createdAt = new Date('2026-01-05T10:00:00.000Z');
      const file = {
        id: 'file-1',
        createdAt,
        // Simulates the read path bumping @updatedAt between the two HEADs.
        updatedAt: new Date('2026-01-06T10:00:00.000Z'),
        size: 10n,
        etag: '"e1"',
        mimeType: 'text/plain',
      };
      const findObject = jest
        .fn()
        .mockResolvedValueOnce(file)
        .mockResolvedValueOnce({
          ...file,
          updatedAt: new Date('2026-02-20T10:00:00.000Z'),
        });
      const { controller, res } = createController({ findObject });
      const req = { s3UserId: 'user-1', query: {} } as never;

      await controller.headObject(
        'bucket-a',
        { key: 'a.txt' },
        req,
        res as never,
      );
      await controller.headObject(
        'bucket-a',
        { key: 'a.txt' },
        req,
        res as never,
      );

      const lastModifieds = res.setHeader.mock.calls
        .filter((c: unknown[]) => c[0] === 'Last-Modified')
        .map((c: unknown[]) => c[1]);
      expect(lastModifieds).toHaveLength(2);
      expect(lastModifieds[0]).toBe(lastModifieds[1]);
      expect(lastModifieds[0]).toBe(createdAt.toUTCString());
    });
  });
});
