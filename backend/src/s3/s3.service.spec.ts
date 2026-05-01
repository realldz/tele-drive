import { BadRequestException } from '@nestjs/common';
import { S3Service } from './s3.service';

describe('S3Service', () => {
  let service: S3Service;

  beforeEach(() => {
    // S3Service only needs prisma in constructor — mock it minimally
    service = new S3Service({ folder: {}, fileRecord: {} } as any);
  });

  describe('parseDeleteObjectsXml', () => {
    it('should parse keys from valid XML', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Delete>
  <Object><Key>photos/img1.jpg</Key></Object>
  <Object><Key>photos/img2.jpg</Key></Object>
</Delete>`;
      const result = service.parseDeleteObjectsXml(xml);
      expect(result.quiet).toBe(false);
      expect(result.keys).toEqual(['photos/img1.jpg', 'photos/img2.jpg']);
    });

    it('should parse Quiet=true', () => {
      const xml = `<Delete><Quiet>true</Quiet><Object><Key>a.txt</Key></Object></Delete>`;
      const result = service.parseDeleteObjectsXml(xml);
      expect(result.quiet).toBe(true);
      expect(result.keys).toEqual(['a.txt']);
    });

    it('should default Quiet to false when omitted', () => {
      const xml = `<Delete><Object><Key>a.txt</Key></Object></Delete>`;
      const result = service.parseDeleteObjectsXml(xml);
      expect(result.quiet).toBe(false);
    });

    it('should decode XML entities in keys', () => {
      const xml = `<Delete><Object><Key>a&amp;b.txt</Key></Object></Delete>`;
      const result = service.parseDeleteObjectsXml(xml);
      expect(result.keys).toEqual(['a&b.txt']);
    });

    it('should throw BadRequestException on more than 1000 keys', () => {
      const objects = Array.from(
        { length: 1001 },
        (_, i) => `<Object><Key>file${i}.txt</Key></Object>`,
      ).join('');
      const xml = `<Delete>${objects}</Delete>`;
      expect(() => service.parseDeleteObjectsXml(xml)).toThrow(
        BadRequestException,
      );
      expect(() => service.parseDeleteObjectsXml(xml)).toThrow('MalformedXML');
    });

    it('should throw on empty key list', () => {
      const xml = `<Delete></Delete>`;
      expect(() => service.parseDeleteObjectsXml(xml)).toThrow('MalformedXML');
    });
  });

  describe('resolveKeyAsFolder', () => {
    it('creates full folder chain for key like docs/reports/ and returns leaf folder id', async () => {
      const prisma = {
        folder: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null),
          create: jest
            .fn()
            .mockResolvedValueOnce({ id: 'bucket-id' })
            .mockResolvedValueOnce({ id: 'folder-docs' })
            .mockResolvedValueOnce({ id: 'folder-reports' }),
        },
        fileRecord: {},
      } as any;
      service = new S3Service(prisma);

      await expect(
        service.resolveKeyAsFolder('user-1', 'bucket-a', 'docs/reports/'),
      ).resolves.toBe('folder-reports');

      expect(prisma.folder.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          name: 'bucket-a',
          parentId: null,
          deletedAt: null,
        },
      });
      expect(prisma.folder.create).toHaveBeenNthCalledWith(1, {
        data: { name: 'bucket-a', parentId: null, userId: 'user-1' },
      });
      expect(prisma.folder.findFirst).toHaveBeenCalledWith({
        where: {
          name: 'docs',
          parentId: 'bucket-id',
          userId: 'user-1',
          deletedAt: null,
        },
      });
      expect(prisma.folder.create).toHaveBeenNthCalledWith(2, {
        data: { name: 'docs', parentId: 'bucket-id', userId: 'user-1' },
      });
      expect(prisma.folder.findFirst).toHaveBeenCalledWith({
        where: {
          name: 'reports',
          parentId: 'folder-docs',
          userId: 'user-1',
          deletedAt: null,
        },
      });
      expect(prisma.folder.create).toHaveBeenNthCalledWith(3, {
        data: { name: 'reports', parentId: 'folder-docs', userId: 'user-1' },
      });
      expect(prisma.folder.findFirst).toHaveBeenCalledTimes(4);
    });

    it('returns existing folder id when folder already exists', async () => {
      const prisma = {
        folder: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({ id: 'bucket-id' })
            .mockResolvedValueOnce({ id: 'folder-docs' })
            .mockResolvedValueOnce({ id: 'folder-reports' }),
          create: jest.fn(),
        },
        fileRecord: {},
      } as any;
      service = new S3Service(prisma);

      await expect(
        service.resolveKeyAsFolder('user-1', 'bucket-a', 'docs/reports/'),
      ).resolves.toBe('folder-reports');

      expect(prisma.folder.create).not.toHaveBeenCalled();
    });

    it('throws on empty key / with InvalidArgument', async () => {
      await expect(
        service.resolveKeyAsFolder('user-1', 'bucket-a', '/'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.resolveKeyAsFolder('user-1', 'bucket-a', '/'),
      ).rejects.toThrow('InvalidArgument');
    });

    it('rejects non-folder keys with InvalidArgument', async () => {
      await expect(
        service.resolveKeyAsFolder('user-1', 'bucket-a', 'docs/file.txt'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.resolveKeyAsFolder('user-1', 'bucket-a', 'docs/file.txt'),
      ).rejects.toThrow('InvalidArgument');
    });
  });

  describe('buildDeleteResultXml', () => {
    it('should include both Deleted and Error entries in verbose mode', () => {
      const xml = service.buildDeleteResultXml(
        [{ key: 'ok.txt' }],
        [
          {
            key: 'missing.txt',
            code: 'NoSuchKey',
            message: 'The specified key does not exist.',
          },
        ],
        false,
      );

      expect(xml).toContain('<Deleted>');
      expect(xml).toContain('<Key>ok.txt</Key>');
      expect(xml).toContain('<Error>');
      expect(xml).toContain('<Key>missing.txt</Key>');
      expect(xml).toContain('<Code>NoSuchKey</Code>');
      expect(xml).toContain(
        '<Message>The specified key does not exist.</Message>',
      );
    });

    it('should include only Error entries in quiet mode', () => {
      const xml = service.buildDeleteResultXml(
        [{ key: 'ok.txt' }],
        [
          {
            key: 'missing.txt',
            code: 'NoSuchKey',
            message: 'The specified key does not exist.',
          },
        ],
        true,
      );

      expect(xml).not.toContain('<Deleted>');
      expect(xml).toContain('<Error>');
      expect(xml).toContain('<Key>missing.txt</Key>');
    });

    it('should return empty DeleteResult body for all-success quiet mode', () => {
      const xml = service.buildDeleteResultXml([{ key: 'ok.txt' }], [], true);

      expect(xml).toContain(
        '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>',
      );
      expect(xml).not.toContain('<Deleted>');
      expect(xml).not.toContain('<Error>');
    });

    it('should escape XML entities in output', () => {
      const xml = service.buildDeleteResultXml(
        [{ key: `a&b<"'` }],
        [{ key: `x&y`, code: `Bad<&>"'`, message: `Oops<&>"'` }],
        false,
      );

      expect(xml).toContain('<Key>a&amp;b&lt;&quot;&apos;</Key>');
      expect(xml).toContain('<Key>x&amp;y</Key>');
      expect(xml).toContain('<Code>Bad&lt;&amp;&gt;&quot;&apos;</Code>');
      expect(xml).toContain('<Message>Oops&lt;&amp;&gt;&quot;&apos;</Message>');
    });
  });

  describe('buildListObjectsV2Xml', () => {
    it('renders the provided stable object timestamp in LastModified', () => {
      const createdAt = new Date('2026-05-01T01:02:03.000Z');
      const updatedAt = new Date('2026-05-02T04:05:06.000Z');

      const xml = service.buildListObjectsV2Xml(
        'demo-bucket',
        [
          {
            key: 'archive/demo.txt',
            size: 123n,
            lastModified: createdAt,
            etag: '"etag-1"',
          },
        ],
        [],
        '',
        '/',
        1000,
        false,
      );

      expect(xml).toContain(`<LastModified>${createdAt.toISOString()}</LastModified>`);
      expect(xml).not.toContain(updatedAt.toISOString());
    });

    it('supports encoding-type=url for keys, prefixes, and delimiters', () => {
      const xml = service.buildListObjectsV2Xml(
        'demo-bucket',
        [
          {
            key: "folder one/[clip] 星火+demo's.mp4",
            size: 123n,
            lastModified: new Date('2026-05-01T01:02:03.000Z'),
            etag: '"etag-1"',
          },
        ],
        ['folder one/sub dir/'],
        'folder one/',
        '/',
        1000,
        false,
        'url',
      );

      expect(xml).toContain('<EncodingType>url</EncodingType>');
      expect(xml).toContain('<KeyCount>2</KeyCount>');
      expect(xml).toContain('<Prefix>folder%20one%2F</Prefix>');
      expect(xml).toContain('<Delimiter>%2F</Delimiter>');
      expect(xml).toContain(
        '<Key>folder%20one%2F%5Bclip%5D%20%E6%98%9F%E7%81%AB%2Bdemo%27s.mp4</Key>',
      );
      expect(xml).toContain(
        '<Prefix>folder%20one%2Fsub%20dir%2F</Prefix>',
      );
    });
  });

  describe('listObjects ordering', () => {
    it('returns keys sorted lexicographically for sync compatibility', async () => {
      const prisma = {
        folder: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({ id: 'bucket-id' })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        fileRecord: {
          findMany: jest.fn().mockResolvedValue([
            {
              filename: 'zeta.mp4',
              size: 2n,
              createdAt: new Date('2026-05-01T00:00:00.000Z'),
              updatedAt: new Date('2026-05-02T00:00:00.000Z'),
              id: 'file-z',
              etag: '"etag-z"',
            },
            {
              filename: 'alpha.mp4',
              size: 1n,
              createdAt: new Date('2026-05-01T00:00:00.000Z'),
              updatedAt: new Date('2026-05-02T00:00:00.000Z'),
              id: 'file-a',
              etag: '"etag-a"',
            },
          ]),
          findFirst: jest.fn().mockResolvedValue(null),
        },
      } as any;
      service = new S3Service(prisma);

      const result = await service.listObjects(
        'user-1',
        'bucket-a',
        '',
        undefined,
        1000,
      );

      expect(result.objects.map((object) => object.key)).toEqual([
        'alpha.mp4',
        'zeta.mp4',
      ]);
    });
  });

  describe('cleanupEmptyFolders', () => {
    it('soft-deletes empty ancestors until reaching the bucket root', async () => {
      const prisma = {
        folder: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({ id: 'leaf', parentId: 'parent' })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'parent', parentId: 'bucket' })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'bucket', parentId: null }),
          update: jest.fn().mockResolvedValue({}),
        },
        fileRecord: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      } as any;
      service = new S3Service(prisma);

      await service.cleanupEmptyFolders('user-1', 'leaf');

      expect(prisma.folder.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'leaf' },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.folder.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'parent' },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.folder.update).toHaveBeenCalledTimes(2);
    });

    it('stops when the folder still has active files or child folders', async () => {
      const prisma = {
        folder: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({ id: 'leaf', parentId: 'parent' })
            .mockResolvedValueOnce(null),
          update: jest.fn(),
        },
        fileRecord: {
          findFirst: jest.fn().mockResolvedValueOnce({ id: 'file-1' }),
        },
      } as any;
      service = new S3Service(prisma);

      await service.cleanupEmptyFolders('user-1', 'leaf');

      expect(prisma.folder.update).not.toHaveBeenCalled();
    });
  });
});
