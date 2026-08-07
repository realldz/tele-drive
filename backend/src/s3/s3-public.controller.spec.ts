import { S3PublicController } from './s3-public.controller';
import { encodeContinuationToken } from './s3-list-pagination.util';

describe('S3PublicController', () => {
  const createController = (overrides: Record<string, unknown> = {}) => {
    const s3Service = {
      buildErrorXml: jest.fn((code: string, message: string) => {
        return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
      }),
      buildListObjectsV2Xml: jest
        .fn<string, unknown[]>()
        .mockReturnValue('<xml/>'),
      listObjectsPublic: jest
        .fn<Promise<unknown>, unknown[]>()
        .mockResolvedValue({
          objects: [],
          commonPrefixes: [],
          isTruncated: false,
          nextContinuationToken: undefined,
        }),
      ...overrides,
    };

    const controller = new S3PublicController(s3Service as never, {} as never);

    const res = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      end: jest.fn().mockReturnThis(),
    };

    return { controller, s3Service, res };
  };

  /** Minimal public request stub carrying only the query string. */
  const listRequest = (query: Record<string, string>) => ({ query }) as never;

  const emptyPage = {
    objects: [],
    commonPrefixes: [],
    isTruncated: false,
    nextContinuationToken: undefined,
  };

  describe('ListObjectsV2 pagination plumbing', () => {
    /** The `startAfter` argument S3Service.listObjectsPublic was called with. */
    const startAfterArg = (service: jest.Mock<unknown, unknown[]>): unknown =>
      service.mock.calls[0][5];

    /** The `cursors` argument (9th param) buildListObjectsV2Xml received. */
    const cursorsArg = (buildXml: jest.Mock<unknown, unknown[]>): unknown =>
      buildXml.mock.calls[0][8];

    it('threads the decoded continuation token into listObjectsPublic (exclusive resume key)', async () => {
      const listObjectsPublic = jest.fn<Promise<unknown>, unknown[]>();
      listObjectsPublic.mockResolvedValue(emptyPage);
      const { controller, res, s3Service } = createController({
        listObjectsPublic,
      });
      const token = encodeContinuationToken('docs/đôi bản nhạc.aep');

      await controller.listObjects(
        'user-1',
        'bucket-a',
        listRequest({ 'continuation-token': token }),
        res as never,
      );

      expect(startAfterArg(listObjectsPublic)).toBe('docs/đôi bản nhạc.aep');
      // Echo the raw client token back into the XML builder.
      expect(cursorsArg(s3Service.buildListObjectsV2Xml)).toMatchObject({
        continuationToken: token,
      });
    });

    it('passes the page truncation state and next token into the XML builder', async () => {
      // Simulates the service returning a truncated page of 1000 objects with
      // a resume token — the exact shape the old controller threw away.
      const objects = Array.from({ length: 1000 }, (_, i) => ({
        key: `file-${i}.txt`,
        size: 1n,
        lastModified: new Date('2026-05-01T00:00:00.000Z'),
        etag: '"e"',
      }));
      const listObjectsPublic = jest.fn<Promise<unknown>, unknown[]>();
      listObjectsPublic.mockResolvedValue({
        objects,
        commonPrefixes: [],
        isTruncated: true,
        nextContinuationToken: 'dG9rZW4=',
      });
      const { controller, res, s3Service } = createController({
        listObjectsPublic,
      });

      await controller.listObjects(
        'user-1',
        'bucket-a',
        listRequest({}),
        res as never,
      );

      expect(s3Service.buildListObjectsV2Xml).toHaveBeenCalledWith(
        'bucket-a',
        objects,
        [],
        '',
        '',
        1000,
        true, // isTruncated comes from the page, never recomputed from length
        '', // encoding-type (absent query param → empty string, like the authed surface)
        {
          nextContinuationToken: 'dG9rZW4=',
          continuationToken: undefined,
          startAfter: undefined,
        },
      );
    });

    it('echoes start-after into the XML builder and lists from it when present', async () => {
      const listObjectsPublic = jest.fn<Promise<unknown>, unknown[]>();
      listObjectsPublic.mockResolvedValue(emptyPage);
      const { controller, res, s3Service } = createController({
        listObjectsPublic,
      });

      await controller.listObjects(
        'user-1',
        'bucket-a',
        listRequest({ 'start-after': 'a.txt' }),
        res as never,
      );

      expect(startAfterArg(listObjectsPublic)).toBe('a.txt');
      expect(cursorsArg(s3Service.buildListObjectsV2Xml)).toMatchObject({
        startAfter: 'a.txt',
      });
    });

    it('does not pass a cursor when neither continuation-token nor start-after is present', async () => {
      const listObjectsPublic = jest.fn<Promise<unknown>, unknown[]>();
      listObjectsPublic.mockResolvedValue(emptyPage);
      const { controller, res, s3Service } = createController({
        listObjectsPublic,
      });

      await controller.listObjects(
        'user-1',
        'bucket-a',
        listRequest({}),
        res as never,
      );

      expect(startAfterArg(listObjectsPublic)).toBeUndefined();
      expect(cursorsArg(s3Service.buildListObjectsV2Xml)).toEqual({
        nextContinuationToken: undefined,
        continuationToken: undefined,
        startAfter: undefined,
      });
    });

    it('rejects a malformed continuation-token with a 400 InvalidArgument body (before listing)', async () => {
      const listObjectsPublic = jest.fn<Promise<unknown>, unknown[]>();
      const { controller, res, s3Service } = createController({
        listObjectsPublic,
      });

      await controller.listObjects(
        'user-1',
        'bucket-a',
        listRequest({ 'continuation-token': '!!!!' }),
        res as never,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(s3Service.buildErrorXml).toHaveBeenCalledWith(
        'InvalidArgument',
        expect.anything(),
      );
      expect(res.send).toHaveBeenCalled();
      // A forged cursor must never reach the listing path.
      expect(listObjectsPublic).not.toHaveBeenCalled();
    });
  });

  describe('max-keys sanitization', () => {
    /** The `maxKeys` argument S3Service.listObjectsPublic was called with (idx 4). */
    const maxKeysArg = (service: jest.Mock<unknown, unknown[]>): unknown =>
      service.mock.calls[0][4];

    it('defaults to 1000 when max-keys is absent', async () => {
      const listObjectsPublic = jest.fn<Promise<unknown>, unknown[]>();
      listObjectsPublic.mockResolvedValue(emptyPage);
      const { controller, res } = createController({ listObjectsPublic });
      await controller.listObjects(
        'user-1',
        'bucket-a',
        listRequest({}),
        res as never,
      );
      expect(maxKeysArg(listObjectsPublic)).toBe(1000);
    });

    it('clamps a value above 1000 to 1000', async () => {
      const listObjectsPublic = jest.fn<Promise<unknown>, unknown[]>();
      listObjectsPublic.mockResolvedValue(emptyPage);
      const { controller, res } = createController({ listObjectsPublic });
      await controller.listObjects(
        'user-1',
        'bucket-a',
        listRequest({ 'max-keys': '5000' }),
        res as never,
      );
      expect(maxKeysArg(listObjectsPublic)).toBe(1000);
    });

    it('passes 0 through unchanged', async () => {
      const listObjectsPublic = jest.fn<Promise<unknown>, unknown[]>();
      listObjectsPublic.mockResolvedValue(emptyPage);
      const { controller, res } = createController({ listObjectsPublic });
      await controller.listObjects(
        'user-1',
        'bucket-a',
        listRequest({ 'max-keys': '0' }),
        res as never,
      );
      expect(maxKeysArg(listObjectsPublic)).toBe(0);
    });

    it('rejects a partially-numeric value ("12abc") with 400 instead of silently parsing to 12', async () => {
      const listObjectsPublic = jest.fn<Promise<unknown>, unknown[]>();
      const { controller, res, s3Service } = createController({
        listObjectsPublic,
      });

      await controller.listObjects(
        'user-1',
        'bucket-a',
        listRequest({ 'max-keys': '12abc' }),
        res as never,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(s3Service.buildErrorXml).toHaveBeenCalledWith(
        'InvalidArgument',
        expect.anything(),
      );
      // The listing must never run on an unsanitized max-keys.
      expect(listObjectsPublic).not.toHaveBeenCalled();
    });

    it('rejects a negative max-keys with 400', async () => {
      const listObjectsPublic = jest.fn<Promise<unknown>, unknown[]>();
      const { controller, res, s3Service } = createController({
        listObjectsPublic,
      });

      await controller.listObjects(
        'user-1',
        'bucket-a',
        listRequest({ 'max-keys': '-5' }),
        res as never,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(s3Service.buildErrorXml).toHaveBeenCalledWith(
        'InvalidArgument',
        expect.anything(),
      );
      expect(listObjectsPublic).not.toHaveBeenCalled();
    });
  });

  describe('sendS3Error Code/Message split', () => {
    const sendS3Error = (
      controller: S3PublicController,
      res: unknown,
      err: unknown,
    ): void =>
      (
        controller as unknown as {
          sendS3Error: (res: unknown, err: unknown) => void;
        }
      ).sendS3Error(res, err);

    it('splits "NoSuchKey: some/key" so <Code> stays a real S3 code', () => {
      const { controller, s3Service, res } = createController();

      sendS3Error(controller, res, { message: 'NoSuchKey: some/key' });

      expect(res.status).toHaveBeenCalledWith(404);
      expect(s3Service.buildErrorXml).toHaveBeenCalledWith(
        'NoSuchKey',
        'some/key',
      );
      // The whole string must never land in <Code>.
      expect(s3Service.buildErrorXml.mock.calls[0][0]).not.toBe(
        'NoSuchKey: some/key',
      );
    });

    it('keeps a colonless code identical in Code and Message', () => {
      const { controller, s3Service, res } = createController();

      sendS3Error(controller, res, { message: 'NoSuchBucket' });

      expect(res.status).toHaveBeenCalledWith(404);
      expect(s3Service.buildErrorXml).toHaveBeenCalledWith(
        'NoSuchBucket',
        'NoSuchBucket',
      );
    });
  });
});
