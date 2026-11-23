import { NotFoundException } from '@nestjs/common';
import { FileMetadataService } from './file-metadata.service';

describe('FileMetadataService.getSharedFileInfo', () => {
  const prisma = {
    fileRecord: { findFirst: jest.fn() },
  };
  const service = new FileMetadataService(prisma as never, {} as never);

  beforeEach(() => jest.clearAllMocks());

  it('only selects public metadata and requires an active, complete share', async () => {
    const publicInfo = {
      id: 'file',
      filename: 'image.jpg',
      size: 12n,
      mimeType: 'image/jpeg',
      createdAt: new Date(),
      user: { username: 'owner' },
    };
    prisma.fileRecord.findFirst.mockResolvedValue(publicInfo);
    expect(await service.getSharedFileInfo('token')).toEqual(publicInfo);
    expect(prisma.fileRecord.findFirst).toHaveBeenCalledWith({
      where: {
        shareToken: 'token',
        visibility: 'PUBLIC_LINK',
        deletedAt: null,
        status: 'complete',
      },
      select: {
        id: true,
        filename: true,
        size: true,
        mimeType: true,
        createdAt: true,
        user: { select: { username: true } },
      },
    });
  });

  it('rejects missing, revoked, deleted or incomplete shares', async () => {
    prisma.fileRecord.findFirst.mockResolvedValue(null);
    await expect(service.getSharedFileInfo('revoked')).rejects.toThrow(
      NotFoundException,
    );
  });
});
