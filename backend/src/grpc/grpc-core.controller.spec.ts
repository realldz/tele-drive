import { GrpcCoreController } from './grpc-core.controller';

/**
 * Zero-byte + metadata regressions from Phase 02.
 *
 * The bug these lock down: ANY zero-byte PUT used to be treated as a folder
 * marker, so `PUT foo/empty.txt` (0 bytes) created a FOLDER named empty.txt.
 * List then emitted it as `foo/empty.txt/` with a trailing slash, so a client
 * asking for `foo/empty.txt` never found it and re-uploaded on every sync.
 * Only a key ending in '/' is a folder marker.
 */
/**
 * Prisma stub shape used by these tests. Typed explicitly (rather than `any`)
 * so assertions on `.mock.calls` stay type-checked.
 */
interface PrismaStub {
  fileRecord: {
    create: jest.Mock<Promise<{ id: string }>, [CreateArgs]>;
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
  $executeRaw: jest.Mock<Promise<number>, unknown[]>;
  $transaction: jest.Mock;
}

/** Shape of the single argument passed to prisma.fileRecord.create. */
interface CreateArgs {
  data: Record<string, unknown>;
}

describe('GrpcCoreController', () => {
  /**
   * Prisma stub whose $transaction runs the callback against the same stub,
   * so the real transaction body (create + overwrite-to-trash + quota) executes.
   */
  const createPrisma = (
    staleRows: Array<Record<string, unknown>> = [],
  ): PrismaStub => {
    const prisma = {
      fileRecord: {
        create: jest
          .fn<Promise<{ id: string }>, [CreateArgs]>()
          .mockResolvedValue({ id: 'new-file-id' }),
        findMany: jest.fn().mockResolvedValue(staleRows),
        updateMany: jest.fn().mockResolvedValue({ count: staleRows.length }),
      },
      $executeRaw: jest.fn<Promise<number>, unknown[]>().mockResolvedValue(1),
      $transaction: jest.fn(),
    } satisfies PrismaStub;
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb(prisma),
    );
    return prisma;
  };

  const createController = (
    prisma: PrismaStub,
    s3Service: Record<string, unknown>,
    cryptoService: Record<string, unknown> = {},
  ) =>
    new GrpcCoreController(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      s3Service as never,
      cryptoService as never,
    );

  /** The `data` payload of the first fileRecord.create call. */
  const createdData = (prisma: PrismaStub): Record<string, unknown> =>
    prisma.fileRecord.create.mock.calls[0][0].data;

  /** The bound parameters of the first $executeRaw call. */
  const executeRawArgs = (prisma: PrismaStub): unknown[] =>
    prisma.$executeRaw.mock.calls[0];

  describe('prepareS3Put — zero-byte keys', () => {
    it('treats a key WITH a trailing slash as a folder marker (no FileRecord)', async () => {
      const prisma = createPrisma();
      const resolveKeyAsFolder = jest.fn().mockResolvedValue('folder-1');
      const resolveKey = jest.fn();
      const controller = createController(prisma, {
        resolveKeyAsFolder,
        resolveKey,
      });

      const res = await controller.prepareS3Put({
        userId: 'user-1',
        bucket: 'bucket-a',
        key: 'docs/sub/',
        mimeType: '',
        contentLength: 0,
      });

      expect(resolveKeyAsFolder).toHaveBeenCalledWith(
        'user-1',
        'bucket-a',
        'docs/sub/',
      );
      expect(res).toEqual({
        fileId: '',
        folderId: 'folder-1',
        encryptedKey: '',
        isEncrypted: false,
        isEmptyObject: false,
      });
      // A folder marker must never materialise as an object row.
      expect(prisma.fileRecord.create).not.toHaveBeenCalled();
      expect(resolveKey).not.toHaveBeenCalled();
    });

    it('treats a zero-byte key WITHOUT a slash as a real empty object', async () => {
      const prisma = createPrisma();
      const resolveKeyAsFolder = jest.fn();
      const resolveKey = jest.fn().mockResolvedValue({ folderId: 'folder-1' });
      const controller = createController(prisma, {
        resolveKeyAsFolder,
        resolveKey,
      });

      const res = await controller.prepareS3Put({
        userId: 'user-1',
        bucket: 'bucket-a',
        key: 'foo/empty.txt',
        mimeType: 'text/plain',
        contentLength: 0,
      });

      // The regression: this must NOT go down the folder path.
      expect(resolveKeyAsFolder).not.toHaveBeenCalled();

      expect(prisma.fileRecord.create).toHaveBeenCalledTimes(1);
      const created = createdData(prisma);
      expect(created).toMatchObject({
        filename: 'empty.txt',
        size: 0n,
        status: 'complete',
        // md5 of the empty string — what S3 clients expect for a 0-byte object.
        etag: '"d41d8cd98f00b204e9800998ecf8427e"',
        isEncrypted: false,
        folderId: 'folder-1',
        userId: 'user-1',
      });

      // Nothing to ship to Telegram, so Go must skip ingest.
      expect(res).toEqual({
        fileId: '',
        folderId: 'folder-1',
        encryptedKey: '',
        isEncrypted: false,
        isEmptyObject: true,
      });
    });

    it('treats a bucket-root zero-byte key as an object, not a folder', async () => {
      const prisma = createPrisma();
      const resolveKeyAsFolder = jest.fn();
      const controller = createController(prisma, {
        resolveKeyAsFolder,
        resolveKey: jest.fn().mockResolvedValue({ folderId: undefined }),
      });

      const res = await controller.prepareS3Put({
        userId: 'user-1',
        bucket: 'bucket-a',
        key: 'empty.txt',
        mimeType: '',
        contentLength: 0,
      });

      expect(resolveKeyAsFolder).not.toHaveBeenCalled();
      expect(res.isEmptyObject).toBe(true);
      expect(
        prisma.fileRecord.create.mock.calls[0][0].data.folderId,
      ).toBeNull();
    });

    it('moves prior versions to trash and reclaims only completed bytes on truncate-to-zero', async () => {
      // 'uploading' rows never contributed to usedSpace, so releasing them would
      // over-credit the user.
      const prisma = createPrisma([
        { id: 'old-1', size: 500n, status: 'complete' },
        { id: 'old-2', size: 900n, status: 'uploading' },
      ]);
      const controller = createController(prisma, {
        resolveKeyAsFolder: jest.fn(),
        resolveKey: jest.fn().mockResolvedValue({ folderId: 'folder-1' }),
      });

      await controller.prepareS3Put({
        userId: 'user-1',
        bucket: 'bucket-a',
        key: 'foo/empty.txt',
        mimeType: '',
        contentLength: 0,
      });

      expect(prisma.fileRecord.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['old-1', 'old-2'] } },
        data: { deletedAt: expect.any(Date) as Date },
      });
      // Exactly one clamped quota decrement, for 500 bytes only.
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(executeRawArgs(prisma)).toContain(500n);
    });

    it('does not touch quota when there is no prior version', async () => {
      const prisma = createPrisma([]);
      const controller = createController(prisma, {
        resolveKeyAsFolder: jest.fn(),
        resolveKey: jest.fn().mockResolvedValue({ folderId: 'folder-1' }),
      });

      await controller.prepareS3Put({
        userId: 'user-1',
        bucket: 'bucket-a',
        key: 'foo/empty.txt',
        mimeType: '',
        contentLength: 0,
      });

      expect(prisma.fileRecord.updateMany).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('does not take the empty-object path for a non-empty body', async () => {
      const prisma = createPrisma();
      const resolveKeyAsFolder = jest.fn();
      const controller = createController(
        prisma,
        {
          resolveKeyAsFolder,
          resolveKey: jest.fn().mockResolvedValue({ folderId: 'folder-1' }),
        },
        {
          generateFileKey: jest.fn().mockReturnValue('raw-key'),
          encryptKey: jest.fn().mockReturnValue('enc-key'),
        },
      );

      const res = await controller.prepareS3Put({
        userId: 'user-1',
        bucket: 'bucket-a',
        key: 'foo/real.txt',
        mimeType: 'text/plain',
        contentLength: 10,
      });

      expect(resolveKeyAsFolder).not.toHaveBeenCalled();
      // Real body → Go must ingest it, so no empty-object short circuit.
      expect(res.isEmptyObject).toBeFalsy();
      expect(res.fileId).toBe('new-file-id');
      // Persisted as 'uploading' with the real size, not a completed 0-byte row.
      expect(createdData(prisma)).toMatchObject({
        size: 10n,
        status: 'uploading',
      });
    });
  });

  describe('resolveS3Object — LastModified', () => {
    const file = {
      id: 'file-1',
      mimeType: 'text/plain',
      size: 42n,
      etag: '"e1"',
      createdAt: new Date('2026-01-05T10:00:00.000Z'),
      // @updatedAt advances on read-path counter writes; using it made a plain
      // GET look like a mutation to sync clients.
      updatedAt: new Date('2026-07-30T23:59:00.000Z'),
    };

    it('derives lastModified from createdAt, never updatedAt', async () => {
      const controller = createController(createPrisma(), {
        findObject: jest.fn().mockResolvedValue(file),
      });

      const res = await controller.resolveS3Object({
        userId: 'user-1',
        bucket: 'bucket-a',
        key: 'a.txt',
      });

      expect(res.found).toBe(true);
      expect(res.lastModified).toBe(file.createdAt.toUTCString());
      expect(res.lastModified).not.toBe(file.updatedAt.toUTCString());
    });

    it('stays stable across repeated resolves even as updatedAt drifts', async () => {
      const findObject = jest
        .fn()
        .mockResolvedValueOnce(file)
        .mockResolvedValueOnce({
          ...file,
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        });
      const controller = createController(createPrisma(), { findObject });
      const args = { userId: 'user-1', bucket: 'bucket-a', key: 'a.txt' };

      const first = await controller.resolveS3Object(args);
      const second = await controller.resolveS3Object(args);

      expect(first.lastModified).toBe(second.lastModified);
    });

    it('returns found=false rather than throwing for an unknown key', async () => {
      const controller = createController(createPrisma(), {
        findObject: jest.fn().mockRejectedValue(new Error('NoSuchKey')),
      });

      const res = await controller.resolveS3Object({
        userId: 'user-1',
        bucket: 'bucket-a',
        key: 'missing.txt',
      });

      expect(res.found).toBe(false);
      expect(res.lastModified).toBe('');
    });
  });
});
