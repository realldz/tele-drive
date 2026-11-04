import { FolderService } from './folder.service';

type MockPrisma = {
  folder: { findMany: jest.Mock; count: jest.Mock };
  fileRecord: { findMany: jest.Mock; count: jest.Mock };
};

const encode = (value: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(value)).toString('base64');
const decode = (value: string | null) =>
  JSON.parse(
    Buffer.from(value as string, 'base64').toString('utf-8'),
  ) as Record<string, unknown>;

const folder = (id: string) => ({
  id,
  name: id,
  parentId: null,
  userId: 'user-1',
  visibility: 'PUBLIC_LINK',
  shareToken: `token-${id}`,
  s3PublicAccess: false,
  createdAt: new Date(),
  updatedAt: new Date(),
});
const file = (id: string) => ({
  id,
  filename: id,
  size: 1n,
  mimeType: 'text/plain',
  status: 'complete',
  totalChunks: 1,
  folderId: null,
  userId: 'user-1',
  visibility: 'PUBLIC_LINK',
  shareToken: `token-${id}`,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('FolderService.listShared pagination', () => {
  const createService = () => {
    const prisma: MockPrisma = {
      folder: { findMany: jest.fn(), count: jest.fn().mockResolvedValue(5) },
      fileRecord: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(4),
      },
    };
    const service = new FolderService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => {});
    return { service, prisma };
  };

  it('carries initial file progress and totals inside the folder continuation', async () => {
    const { service, prisma } = createService();
    prisma.folder.findMany.mockResolvedValue([
      folder('folder-1'),
      folder('folder-2'),
    ]);
    prisma.fileRecord.findMany.mockResolvedValue([
      file('file-1'),
      file('file-2'),
    ]);

    const result = await service.listShared('user-1', { limit: 1 });

    expect(decode(result.nextFolderCursor)).toMatchObject({
      f: 'folder-1',
      fc: 'file-1',
    });
    expect(result).toMatchObject({ totalFolders: 5, totalFiles: 4 });
  });

  it('preserves the file cursor and reuses totals on a folder-only page', async () => {
    const { service, prisma } = createService();
    prisma.folder.findMany.mockResolvedValue([
      folder('folder-2'),
      folder('folder-3'),
    ]);
    const cursor = encode({ f: 'folder-1', fc: 'file-1' });

    const result = await service.listShared('user-1', {
      cursor,
      limit: 1,
      includeTotals: false,
    });

    expect(prisma.fileRecord.findMany).not.toHaveBeenCalled();
    expect(prisma.folder.count).not.toHaveBeenCalled();
    expect(prisma.fileRecord.count).not.toHaveBeenCalled();
    expect(decode(result.nextFolderCursor)).toMatchObject({
      f: 'folder-2',
      fc: 'file-1',
    });
    expect(decode(result.nextFileCursor)).toMatchObject({
      fc: 'file-1',
    });
    expect(result.totalFolders).toBeUndefined();
    expect(result.totalFiles).toBeUndefined();
  });

  it('does not restart files after a cursor records that their first page was complete', async () => {
    const { service, prisma } = createService();
    prisma.folder.findMany.mockResolvedValue([folder('folder-2')]);
    const cursor = encode({ f: 'folder-1', fd: true });

    const result = await service.listShared('user-1', {
      cursor,
      limit: 1,
      includeTotals: false,
    });

    expect(prisma.fileRecord.findMany).not.toHaveBeenCalled();
    expect(result.nextFolderCursor).toBeNull();
    expect(result.nextFileCursor).toBeNull();
    expect(result.totalFolders).toBeUndefined();
    expect(result.totalFiles).toBeUndefined();
  });

  it('continues files after the carried cursor when folders finish', async () => {
    const { service, prisma } = createService();
    prisma.folder.findMany.mockResolvedValue([folder('folder-2')]);
    prisma.fileRecord.findMany.mockResolvedValue([file('file-2')]);
    const cursor = encode({ f: 'folder-1', fc: 'file-1' });

    await service.listShared('user-1', {
      cursor,
      limit: 1,
      includeTotals: false,
    });

    expect(prisma.fileRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'file-1' }, skip: 1 }),
    );
    expect(prisma.folder.count).not.toHaveBeenCalled();
    expect(prisma.fileRecord.count).not.toHaveBeenCalled();
  });
});
