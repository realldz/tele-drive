import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FolderService } from './folder.service';

const root = {
  id: 'root',
  name: 'Shared',
  createdAt: new Date('2026-01-01'),
  deletedAt: null,
  user: { username: 'owner' },
  userId: 'private-user',
  shareToken: 'private-token',
  s3PublicAccess: true,
};
const folder = {
  id: 'child',
  name: 'Child',
  createdAt: new Date('2026-01-02'),
  userId: 'private-user',
  shareToken: 'another-private-token',
};
const file = {
  id: 'file',
  filename: 'photo.jpg',
  size: 15n,
  mimeType: 'image/jpeg',
  createdAt: new Date('2026-01-03'),
  encryptionKey: 'SECRET',
  telegramFileId: 'PRIVATE',
};

function selectPublicFields<T extends object>(record: T, select?: Record<string, boolean>) {
  if (!select) return record;
  return Object.fromEntries(
    Object.keys(select).map((key) => [key, record[key as keyof T]]),
  );
}

function createService() {
  const prisma = {
    folder: {
      findFirst: jest.fn().mockResolvedValue(root),
      findUnique: jest.fn(),
      findMany: jest.fn().mockImplementation(
        ({ select }: { select?: Record<string, boolean> }) =>
          Promise.resolve([selectPublicFields(folder, select)]),
      ),
    },
    fileRecord: {
      findMany: jest.fn().mockImplementation(
        ({ select }: { select?: Record<string, boolean> }) =>
          Promise.resolve([selectPublicFields(file, select)]),
      ),
    },
  };
  const service = new FolderService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  jest.spyOn(service, 'isDescendantOf').mockResolvedValue(true);
  return { service, prisma };
}

const safeFolder = {
  id: folder.id,
  name: folder.name,
  createdAt: folder.createdAt,
};
const safeFile = {
  id: file.id,
  filename: file.filename,
  size: file.size,
  mimeType: file.mimeType,
  createdAt: file.createdAt,
};
const safeRoot = {
  id: root.id,
  name: root.name,
  createdAt: root.createdAt,
  user: root.user,
};

describe('FolderService.getSharedContent public response', () => {
  it.each([true, false])(
    'only exposes approved fields (pagination=%s)',
    async (paginated) => {
      const { service, prisma } = createService();
      const response = await service.getSharedContent(
        'token',
        undefined,
        paginated ? { limit: 10 } : undefined,
      );

      expect(response).toMatchObject({
        rootFolder: safeRoot,
        folders: [safeFolder],
        files: [safeFile],
      });
      expect(Object.keys(response.rootFolder).sort()).toEqual(
        Object.keys(safeRoot).sort(),
      );
      expect(Object.keys(response.folders[0]).sort()).toEqual(
        Object.keys(safeFolder).sort(),
      );
      expect(Object.keys(response.files[0]).sort()).toEqual(
        Object.keys(safeFile).sort(),
      );
      expect(prisma.folder.findFirst).toHaveBeenCalledWith({
        where: { shareToken: 'token', visibility: 'PUBLIC_LINK' },
        select: {
          id: true,
          name: true,
          createdAt: true,
          deletedAt: true,
          user: { select: { username: true } },
        },
      });
      expect(prisma.folder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: { id: true, name: true, createdAt: true },
        }),
      );
      expect(prisma.fileRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: {
            id: true,
            filename: true,
            size: true,
            mimeType: true,
            createdAt: true,
          },
        }),
      );
    },
  );

  it('does not query children for a deleted root', async () => {
    const { service, prisma } = createService();
    prisma.folder.findFirst.mockResolvedValueOnce({
      ...root,
      deletedAt: new Date(),
    });
    await expect(service.getSharedContent('token')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.folder.findMany).not.toHaveBeenCalled();
  });

  it('rejects a revoked link before listing children', async () => {
    const { service, prisma } = createService();
    prisma.folder.findFirst.mockResolvedValueOnce(null);
    await expect(service.getSharedContent('revoked')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.folder.findMany).not.toHaveBeenCalled();
  });

  it('does not query children outside the shared subtree', async () => {
    const { service, prisma } = createService();
    jest.spyOn(service, 'isDescendantOf').mockResolvedValue(false);
    await expect(service.getSharedContent('token', 'foreign')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.fileRecord.findMany).not.toHaveBeenCalled();
  });
});
