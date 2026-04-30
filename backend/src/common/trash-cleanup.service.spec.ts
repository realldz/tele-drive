import { TrashCleanupService } from './trash-cleanup.service';

type MockPrisma = {
  user: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  fileRecord: {
    count: jest.Mock;
    findMany: jest.Mock;
  };
  folder: {
    count: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    delete: jest.Mock;
  };
  $transaction: jest.Mock;
};

type MockFileLifecycleService = {
  purgeFilesFromTelegram: jest.Mock;
};

describe('TrashCleanupService', () => {
  const createService = () => {
    const prisma: MockPrisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      fileRecord: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
      folder: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      $transaction: jest.fn(
        async (callback: (tx: MockPrisma) => Promise<void>) => callback(prisma),
      ),
    };

    const fileLifecycleService: MockFileLifecycleService = {
      purgeFilesFromTelegram: jest.fn().mockResolvedValue(undefined),
    };

    const service = new TrashCleanupService(
      prisma as never,
      fileLifecycleService as never,
    );

    const logger = {
      log: jest
        .spyOn((service as any).logger, 'log')
        .mockImplementation(() => {}),
      warn: jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => {}),
      error: jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation(() => {}),
    };

    return { service, prisma, fileLifecycleService, logger };
  };

  it('clears cleanup flags for remaining users even if one clear fails', async () => {
    const { service, prisma, logger } = createService();

    prisma.fileRecord.findMany.mockResolvedValue([
      {
        id: 'file-1',
        userId: 'user-1',
        status: 'complete',
        size: 5n,
        chunks: [],
      },
      {
        id: 'file-2',
        userId: 'user-2',
        status: 'complete',
        size: 7n,
        chunks: [],
      },
    ]);
    prisma.folder.findMany.mockResolvedValue([]);
    prisma.user.update.mockImplementation(async ({ where, data }) => {
      if (data.isCleaningTrash === false && where.id === 'user-1') {
        throw new Error('clear failed');
      }
      return { id: where.id };
    });

    await service.handleTrashCleanup();

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { isCleaningTrash: true },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-2' },
      data: { isCleaningTrash: true },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { isCleaningTrash: false },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-2' },
      data: { isCleaningTrash: false },
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to clear trash cleanup flag for user user-1',
      ),
    );
  });

  it('downgrades folder delete record-not-found to warn', async () => {
    const { service, prisma, logger } = createService();

    prisma.fileRecord.findMany.mockResolvedValue([]);
    prisma.folder.findMany.mockResolvedValue([
      { id: 'folder-1', userId: 'user-1' },
    ]);
    prisma.folder.findUnique.mockResolvedValue({ id: 'folder-1' });
    prisma.user.update.mockResolvedValue({ id: 'user-1' });
    prisma.folder.delete.mockRejectedValue({
      code: 'P2025',
      name: 'PrismaClientKnownRequestError',
    });

    await service.handleTrashCleanup();

    expect(logger.warn).toHaveBeenCalledWith(
      'Skipped permanently deleting folder folder-1 because it was already removed by cascade or concurrent cleanup',
    );
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to permanently delete folder folder-1'),
    );
  });

  it('clears flags after a batch-level failure during folder lookup', async () => {
    const { service, prisma, logger } = createService();

    prisma.fileRecord.findMany.mockResolvedValue([
      {
        id: 'file-1',
        userId: 'user-1',
        status: 'complete',
        size: 5n,
        chunks: [],
      },
    ]);
    prisma.user.update.mockResolvedValue({ id: 'user-1' });
    prisma.folder.findMany.mockRejectedValue(new Error('folder lookup failed'));

    await service.handleTrashCleanup();

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { isCleaningTrash: false },
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Trash cleanup cron failed: Error: folder lookup failed',
      ),
    );
  });
});
