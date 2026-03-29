import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * S3Service — Path resolution, folder auto-creation, XML response builder.
 *
 * Maps S3 concepts to Tele-Drive:
 *   Bucket   → Root-level Folder (parentId = null)
 *   Object   → FileRecord
 *   Key      → Folder path + filename  (e.g. "docs/2024/report.pdf")
 */
@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Bucket operations (map → root folders)
  // ---------------------------------------------------------------------------

  /** ListBuckets → liệt kê root folders của user */
  async listBuckets(userId: string) {
    const folders = await this.prisma.folder.findMany({
      where: { userId, parentId: null, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { name: true, createdAt: true },
    });
    return folders;
  }

  /** CreateBucket → tạo root folder */
  async createBucket(userId: string, bucketName: string) {
    const existing = await this.prisma.folder.findFirst({
      where: { userId, name: bucketName, parentId: null, deletedAt: null },
    });
    if (existing) return existing;

    const folder = await this.prisma.folder.create({
      data: { name: bucketName, parentId: null, userId },
    });
    this.logger.log(`S3 CreateBucket: "${bucketName}" (userId: ${userId})`);
    return folder;
  }

  /** DeleteBucket → xoá root folder (chỉ khi trống) */
  async deleteBucket(userId: string, bucketName: string) {
    const folder = await this.prisma.folder.findFirst({
      where: { userId, name: bucketName, parentId: null, deletedAt: null },
      include: {
        children: { where: { deletedAt: null }, take: 1 },
        files: { where: { deletedAt: null }, take: 1 },
      },
    });
    if (!folder) throw new NotFoundException('NoSuchBucket');

    if (folder.children.length > 0 || folder.files.length > 0) {
      throw new BadRequestException('BucketNotEmpty');
    }

    await this.prisma.folder.update({ where: { id: folder.id }, data: { deletedAt: new Date() } });
    this.logger.log(`S3 DeleteBucket: "${bucketName}" (userId: ${userId})`);
  }

  // ---------------------------------------------------------------------------
  // Object key resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve S3 key to { folderId, filename }.
   * Key example: "subdir/nested/file.txt" within bucket "my-bucket"
   * → resolves folder chain under bucket, returns { folderId, filename }
   *
   * If create=true, auto-creates missing intermediate folders.
   */
  async resolveKey(
    userId: string,
    bucketName: string,
    key: string,
    create = false,
  ): Promise<{ folderId: string | null; filename: string }> {
    // Find bucket (root folder)
    const bucket = await this.prisma.folder.findFirst({
      where: { userId, name: bucketName, parentId: null, deletedAt: null },
    });

    if (!bucket) {
      if (create) {
        const newBucket = await this.createBucket(userId, bucketName);
        return this.resolveKeyUnderFolder(userId, newBucket.id, key, create);
      }
      throw new NotFoundException('NoSuchBucket');
    }

    return this.resolveKeyUnderFolder(userId, bucket.id, key, create);
  }

  async resolveKeyAsFolder(userId: string, bucketName: string, key: string): Promise<string> {
    const parts = key.split('/').filter(Boolean);
    if (parts.length === 0) throw new BadRequestException('InvalidArgument');

    let bucket = await this.prisma.folder.findFirst({
      where: { userId, name: bucketName, parentId: null, deletedAt: null },
    });

    if (!bucket) {
      bucket = await this.createBucket(userId, bucketName);
    }

    let currentFolderId = bucket.id;

    for (const part of parts) {
      const existing = await this.prisma.folder.findFirst({
        where: { name: part, parentId: currentFolderId, userId, deletedAt: null },
      });

      if (existing) {
        currentFolderId = existing.id;
        continue;
      }

      const folder = await this.prisma.folder.create({
        data: { name: part, parentId: currentFolderId, userId },
      });
      currentFolderId = folder.id;
    }

    return currentFolderId;
  }

  private async resolveKeyUnderFolder(
    userId: string,
    rootFolderId: string,
    key: string,
    create: boolean,
  ): Promise<{ folderId: string | null; filename: string }> {
    const parts = key.split('/').filter(Boolean);
    if (parts.length === 0) throw new BadRequestException('Invalid key');

    const filename = parts[parts.length - 1];
    const dirParts = parts.slice(0, -1);

    let currentFolderId: string = rootFolderId;

    for (const part of dirParts) {
      const existing = await this.prisma.folder.findFirst({
        where: { name: part, parentId: currentFolderId, userId, deletedAt: null },
      });

      if (existing) {
        currentFolderId = existing.id;
      } else if (create) {
        const newFolder = await this.prisma.folder.create({
          data: { name: part, parentId: currentFolderId, userId },
        });
        this.logger.debug(`S3 auto-created folder: "${part}" (parentId: ${currentFolderId})`);
        currentFolderId = newFolder.id;
      } else {
        throw new NotFoundException('NoSuchKey');
      }
    }

    return { folderId: currentFolderId, filename };
  }

  /**
   * Find a FileRecord by bucket + key.
   */
  async findObject(userId: string, bucketName: string, key: string) {
    const { folderId, filename } = await this.resolveKey(userId, bucketName, key, false);

    const file = await this.prisma.fileRecord.findFirst({
      where: { folderId, filename, userId, deletedAt: null, status: 'complete' },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });

    if (!file) throw new NotFoundException('NoSuchKey');
    return file;
  }

  // ---------------------------------------------------------------------------
  // ListObjectsV2 — prefix-based listing
  // ---------------------------------------------------------------------------

  async listObjects(
    userId: string,
    bucketName: string,
    prefix?: string,
    delimiter?: string,
    maxKeys = 1000,
  ): Promise<{
    objects: Array<{ key: string; size: bigint; lastModified: Date; etag: string }>;
    commonPrefixes: string[];
  }> {
    const bucket = await this.prisma.folder.findFirst({
      where: { userId, name: bucketName, parentId: null, deletedAt: null },
    });
    if (!bucket) throw new NotFoundException('NoSuchBucket');

    const objects: Array<{ key: string; size: bigint; lastModified: Date; etag: string }> = [];
    const commonPrefixes = new Set<string>();

    await this.listRecursive(userId, bucket.id, '', prefix || '', delimiter, objects, commonPrefixes, maxKeys);

    return { objects: objects.slice(0, maxKeys), commonPrefixes: [...commonPrefixes] };
  }

  private async listRecursive(
    userId: string,
    folderId: string,
    currentPath: string,
    prefix: string,
    delimiter: string | undefined,
    objects: Array<{ key: string; size: bigint; lastModified: Date; etag: string }>,
    commonPrefixes: Set<string>,
    maxKeys: number,
  ): Promise<void> {
    if (objects.length >= maxKeys) return;

    // List files in current folder
    const files = await this.prisma.fileRecord.findMany({
      where: { folderId, userId, deletedAt: null, status: 'complete' },
      select: { filename: true, size: true, updatedAt: true, id: true, etag: true },
    });

    for (const file of files) {
      const key = currentPath ? `${currentPath}/${file.filename}` : file.filename;

      if (prefix && !key.startsWith(prefix)) continue;

      if (delimiter) {
        const rest = key.substring(prefix.length);
        const delimIdx = rest.indexOf(delimiter);
        if (delimIdx !== -1) {
          commonPrefixes.add(prefix + rest.substring(0, delimIdx + 1));
          continue;
        }
      }

      objects.push({
        key,
        size: file.size,
        lastModified: file.updatedAt,
        etag: file.etag || `"${file.id}"`,
      });
    }

    if (objects.length >= maxKeys) return;

    // Recurse into subfolders
    const subFolders = await this.prisma.folder.findMany({
      where: { parentId: folderId, userId, deletedAt: null },
      select: { id: true, name: true },
    });

    for (const folder of subFolders) {
      const folderPath = currentPath ? `${currentPath}/${folder.name}` : folder.name;

      // If delimiter, collapse folder into common prefix
      if (delimiter) {
        const fullPath = `${folderPath}/`;
        if (!prefix || fullPath.startsWith(prefix) || prefix.startsWith(folderPath)) {
          if (prefix && !prefix.startsWith(folderPath) && !fullPath.startsWith(prefix)) {
            continue;
          }
        }
      }

      await this.listRecursive(userId, folder.id, folderPath, prefix, delimiter, objects, commonPrefixes, maxKeys);
    }
  }

  // ---------------------------------------------------------------------------
  // XML Parser/Response Builder
  // ---------------------------------------------------------------------------

  parseDeleteObjectsXml(body: string): { quiet: boolean; keys: string[] } {
    const quietMatch = body.match(/<Quiet>\s*(true|false)\s*<\/Quiet>/i);
    const quiet = quietMatch ? quietMatch[1].toLowerCase() === 'true' : false;

    const keys: string[] = [];
    const keyRegex = /<Key>([^<]+)<\/Key>/g;
    let match: RegExpExecArray | null;

    while ((match = keyRegex.exec(body)) !== null) {
      keys.push(this.decodeXmlEntities(match[1]));
    }

    if (keys.length === 0 || keys.length > 1000) {
      throw new BadRequestException('MalformedXML');
    }

    return { quiet, keys };
  }

  buildDeleteResultXml(
    deleted: Array<{ key: string }>,
    errors: Array<{ key: string; code: string; message: string }>,
    quiet: boolean,
  ): string {
    const deletedXml = quiet
      ? ''
      : deleted.map((item) => `<Deleted><Key>${this.escapeXml(item.key)}</Key></Deleted>`).join('');

    const errorsXml = errors
      .map(
        (item) =>
          `<Error><Key>${this.escapeXml(item.key)}</Key><Code>${this.escapeXml(item.code)}</Code><Message>${this.escapeXml(item.message)}</Message></Error>`,
      )
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?>\n<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deletedXml}${errorsXml}</DeleteResult>`;
  }

  buildListBucketsXml(buckets: Array<{ name: string; createdAt: Date }>, owner: string): string {
    const bucketsXml = buckets
      .map(
        (b) => `
    <Bucket>
      <Name>${this.escapeXml(b.name)}</Name>
      <CreationDate>${b.createdAt.toISOString()}</CreationDate>
    </Bucket>`,
      )
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner>
    <ID>${this.escapeXml(owner)}</ID>
    <DisplayName>${this.escapeXml(owner)}</DisplayName>
  </Owner>
  <Buckets>${bucketsXml}
  </Buckets>
</ListAllMyBucketsResult>`;
  }

  buildListObjectsV2Xml(
    bucketName: string,
    objects: Array<{ key: string; size: bigint; lastModified: Date; etag: string }>,
    commonPrefixes: string[],
    prefix: string,
    delimiter: string,
    maxKeys: number,
    isTruncated: boolean,
  ): string {
    const objectsXml = objects
      .map(
        (o) => `
  <Contents>
    <Key>${this.escapeXml(o.key)}</Key>
    <LastModified>${o.lastModified.toISOString()}</LastModified>
    <ETag>${this.escapeXml(o.etag)}</ETag>
    <Size>${o.size}</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>`,
      )
      .join('');

    const prefixesXml = commonPrefixes
      .map((p) => `\n  <CommonPrefixes><Prefix>${this.escapeXml(p)}</Prefix></CommonPrefixes>`)
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${this.escapeXml(bucketName)}</Name>
  <Prefix>${this.escapeXml(prefix)}</Prefix>
  <Delimiter>${this.escapeXml(delimiter)}</Delimiter>
  <MaxKeys>${maxKeys}</MaxKeys>
  <IsTruncated>${isTruncated}</IsTruncated>${objectsXml}${prefixesXml}
</ListBucketResult>`;
  }

  buildErrorXml(code: string, message: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>${this.escapeXml(code)}</Code>
  <Message>${this.escapeXml(message)}</Message>
</Error>`;
  }

  private decodeXmlEntities(str: string): string {
    return String(str).replace(/&(lt|gt|quot|apos|amp);/g, (entity) => {
      switch (entity) {
        case '&lt;':
          return '<';
        case '&gt;':
          return '>';
        case '&quot;':
          return '"';
        case '&apos;':
          return "'";
        case '&amp;':
          return '&';
        default:
          return entity;
      }
    });
  }

  private escapeXml(str: string): string {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
