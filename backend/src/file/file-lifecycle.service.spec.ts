import { FileLifecycleService } from './file-lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { TempStorage } from '../common/temp-storage';
import { CdnPurgeService } from '../common/cdn-purge.service';
import Redis from 'ioredis';

describe('bounded permanent deletion', () => {
  const oldFlag = process.env.ENABLE_EVENT_DRIVEN_DELETE;
  const findMany = jest.fn();
  const deletedRows = jest.fn();
  const updateQuota = jest.fn();
  const findFolder = jest.fn();
  const cdn = {
    purgeProviders: jest.fn(() => 'none'),
    purgeDeletedFiles: jest.fn(),
  };
  const tx = { $queryRaw: deletedRows, user: { update: updateQuota } };
  const prisma = {
    fileRecord: { findMany },
    folder: { findUnique: findFolder },
    $transaction: (fn: (client: typeof tx) => Promise<bigint>) => fn(tx),
  } as unknown as PrismaService;
  let service: FileLifecycleService;
  let purge: jest.SpyInstance<
    Promise<void>,
    Parameters<FileLifecycleService['purgeFilesFromTelegram']>
  >;
  let publish: jest.SpyInstance<
    Promise<void>,
    Parameters<FileLifecycleService['publishDeleteEvent']>
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_EVENT_DRIVEN_DELETE = 'false';
    service = new FileLifecycleService(
      prisma,
      {} as TelegramService,
      {} as TempStorage,
      {} as Redis,
      cdn as unknown as CdnPurgeService,
    );
    purge = jest.spyOn(service, 'purgeFilesFromTelegram').mockResolvedValue();
    jest.spyOn(service, 'purgeTempFiles').mockResolvedValue();
    publish = jest.spyOn(service, 'publishDeleteEvent').mockResolvedValue();
    deletedRows.mockResolvedValue([{ size: 10n, status: 'complete' }]);
    findMany.mockImplementation(
      ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.map((id) => ({
            id,
            userId: 'u',
            size: 10n,
            status: 'complete',
            folderId: 'folder',
            filename: id,
            chunks: [],
          })),
        ),
    );
  });
  afterAll(() => {
    if (oldFlag === undefined) delete process.env.ENABLE_EVENT_DRIVEN_DELETE;
    else process.env.ENABLE_EVENT_DRIVEN_DELETE = oldFlag;
  });

  it('bounds metadata batches and delegates one legacy purge per batch', async () => {
    const ids = Array.from({ length: 401 }, (_, i) => `file-${i}`);
    expect(await service.bulkPermanentDeleteFiles(ids, 'u')).toBe(30n);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(purge).toHaveBeenCalledTimes(3);
    expect(purge).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining([
        {
          id: 'file-0',
          userId: 'u',
          size: 10n,
          status: 'complete',
          folderId: 'folder',
          filename: 'file-0',
          chunks: [],
        },
      ]),
    );
    expect(findMany).toHaveBeenLastCalledWith({
      where: { id: { in: ['file-400'] }, userId: 'u' },
      include: { chunks: true },
    });
    expect(findFolder).not.toHaveBeenCalled();
  });

  it('accounts only completed rows actually deleted, not stale metadata', async () => {
    deletedRows.mockResolvedValue([
      { size: 7n, status: 'complete' },
      { size: 90n, status: 'buffered' },
    ]);
    expect(
      await service.bulkPermanentDeleteFiles(
        ['a', 'b', 'already-deleted'],
        'u',
      ),
    ).toBe(7n);
    expect(updateQuota).toHaveBeenCalledWith({
      where: { id: 'u' },
      data: { usedSpace: { decrement: 7n } },
    });
    updateQuota.mockClear();
    deletedRows.mockResolvedValue([]);
    expect(await service.bulkPermanentDeleteFiles(['a'], 'u')).toBe(0n);
    expect(updateQuota).not.toHaveBeenCalled();
  });

  it('does not remove metadata after event publication fails and releases its lock for retry', async () => {
    process.env.ENABLE_EVENT_DRIVEN_DELETE = 'true';
    publish.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(service.bulkPermanentDeleteFiles(['a'], 'u')).rejects.toThrow(
      'Redis unavailable',
    );
    expect(deletedRows).not.toHaveBeenCalled();
    await expect(service.bulkPermanentDeleteFiles(['a'], 'u')).resolves.toBe(
      10n,
    );
  });

  it('does nothing for an empty selection or no remaining owned records', async () => {
    expect(await service.bulkPermanentDeleteFiles([], 'u')).toBe(0n);
    expect(findMany).not.toHaveBeenCalled();
    findMany.mockResolvedValueOnce([]);
    expect(await service.bulkPermanentDeleteFiles(['gone'], 'u')).toBe(0n);
    expect(deletedRows).not.toHaveBeenCalled();
  });
});
