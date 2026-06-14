import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import * as crypto from 'crypto';
import { escapeXml, decodeXmlEntities } from '../common/utils/xml';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
  ) {}

  async generateDownloadToken(fileId: string, userId: string): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex');
    await this.cacheService.setOneTimeToken(
      token,
      { fileId, userId, type: 'download' },
      300,
    );
    return token;
  }

  async generateUploadToken(
    fileId: string,
    userId: string,
    chunkIndex?: number,
  ): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex');
    await this.cacheService.setOneTimeToken(
      token,
      { fileId, userId, type: 'upload', chunkIndex },
      300,
    );
    return token;
  }

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

    await this.prisma.folder.update({
      where: { id: folder.id },
      data: { deletedAt: new Date() },
    });
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

  /**
   * Resolve a folder key ending with '/' and return the leaf folder ID.
   */
  async resolveKeyAsFolder(
    userId: string,
    bucketName: string,
    key: string,
  ): Promise<string> {
    if (!key.endsWith('/')) throw new BadRequestException('InvalidArgument');

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
        where: {
          name: part,
          parentId: currentFolderId,
          userId,
          deletedAt: null,
        },
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

  async cleanupEmptyFolders(
    userId: string,
    folderId: string | null | undefined,
  ): Promise<void> {
    let currentFolderId = folderId;

    while (currentFolderId) {
      const folder = await this.prisma.folder.findFirst({
        where: { id: currentFolderId, userId, deletedAt: null },
        select: { id: true, parentId: true },
      });

      if (!folder || folder.parentId === null) {
        return;
      }

      const [childFolder, file] = await Promise.all([
        this.prisma.folder.findFirst({
          where: { parentId: folder.id, userId, deletedAt: null },
          select: { id: true },
        }),
        this.prisma.fileRecord.findFirst({
          where: { folderId: folder.id, userId, deletedAt: null },
          select: { id: true },
        }),
      ]);

      if (childFolder || file) {
        return;
      }

      await this.prisma.folder.update({
        where: { id: folder.id },
        data: { deletedAt: new Date() },
      });

      currentFolderId = folder.parentId;
    }
  }

  async deleteFolderMarker(
    userId: string,
    bucketName: string,
    key: string,
  ): Promise<boolean> {
    if (!key.endsWith('/')) return false;

    const parts = key.split('/').filter(Boolean);
    if (parts.length === 0) return false;

    const bucket = await this.prisma.folder.findFirst({
      where: { userId, name: bucketName, parentId: null, deletedAt: null },
      select: { id: true },
    });
    if (!bucket) return false;

    let currentFolderId = bucket.id;

    for (const part of parts) {
      const folder = await this.prisma.folder.findFirst({
        where: {
          parentId: currentFolderId,
          name: part,
          userId,
          deletedAt: null,
        },
        select: { id: true },
      });

      if (!folder) return false;
      currentFolderId = folder.id;
    }

    const [childFolder, file] = await Promise.all([
      this.prisma.folder.findFirst({
        where: { parentId: currentFolderId, userId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.fileRecord.findFirst({
        where: { folderId: currentFolderId, userId, deletedAt: null },
        select: { id: true },
      }),
    ]);

    if (childFolder || file) return false;

    await this.prisma.folder.update({
      where: { id: currentFolderId },
      data: { deletedAt: new Date() },
    });

    await this.cleanupEmptyFolders(userId, currentFolderId);
    return true;
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
        where: {
          name: part,
          parentId: currentFolderId,
          userId,
          deletedAt: null,
        },
      });

      if (existing) {
        currentFolderId = existing.id;
      } else if (create) {
        const newFolder = await this.prisma.folder.create({
          data: { name: part, parentId: currentFolderId, userId },
        });
        this.logger.debug(
          `S3 auto-created folder: "${part}" (parentId: ${currentFolderId})`,
        );
        currentFolderId = newFolder.id;
      } else {
        throw new NotFoundException(
          `NoSuchKey: Cannot resolve key ${key} under folder ${rootFolderId}`,
        );
      }
    }

    return { folderId: currentFolderId, filename };
  }

  /**
   * Find a FileRecord by bucket + key.
   */
  async findObject(userId: string, bucketName: string, key: string) {
    const { folderId, filename } = await this.resolveKey(
      userId,
      bucketName,
      key,
      false,
    );

    const file = await this.prisma.fileRecord.findFirst({
      where: {
        folderId,
        filename,
        userId,
        deletedAt: null,
        status: 'complete',
      },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });

    if (!file) throw new NotFoundException('NoSuchKey: ' + key);
    return file;
  }

  async findObjectRecords(
    userId: string,
    bucketName: string,
    key: string,
  ): Promise<
    Array<{
      id: string;
      size: bigint;
      status: string;
      folderId: string | null;
      filename: string;
    }>
  > {
    try {
      const { folderId, filename } = await this.resolveKey(
        userId,
        bucketName,
        key,
        false,
      );

      return await this.prisma.fileRecord.findMany({
        where: {
          folderId,
          filename,
          userId,
          deletedAt: null,
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          size: true,
          status: true,
          folderId: true,
          filename: true,
        },
      });
    } catch (err: unknown) {
      if (err instanceof NotFoundException) {
        return [];
      }

      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Public object access (không yêu cầu userId filter)
  // ---------------------------------------------------------------------------

  /**
   * Find a FileRecord by bucket + key for public access.
   * Bucket must belong to userId AND have s3PublicAccess = true.
   */
  async findObjectPublic(userId: string, bucketName: string, key: string) {
    const bucket = await this.prisma.folder.findFirst({
      where: {
        userId,
        name: bucketName,
        parentId: null,
        s3PublicAccess: true,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!bucket) throw new NotFoundException('NoSuchBucket');

    const { folderId, filename } = await this.resolveKeyUnderFolder(
      userId,
      bucket.id,
      key,
      false,
    );

    const file = await this.prisma.fileRecord.findFirst({
      where: {
        folderId,
        filename,
        userId,
        deletedAt: null,
        status: 'complete',
      },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });

    if (!file) throw new NotFoundException('NoSuchKey: ' + key);
    return file;
  }

  /**
   * ListObjectsV2 cho public bucket.
   * Bucket phải thuộc về userId và có s3PublicAccess = true.
   */
  /**
   * ListObjectsV2 cho public bucket.
   * Bucket phải thuộc về userId và có s3PublicAccess = true.
   */
  async listObjectsPublic(
    userId: string,
    bucketName: string,
    prefix?: string,
    delimiter?: string,
    maxKeys = 1000,
  ): Promise<{
    objects: Array<{
      key: string;
      size: bigint;
      lastModified: Date;
      etag: string;
    }>;
    commonPrefixes: string[];
  }> {
    const bucket = await this.prisma.folder.findFirst({
      where: {
        userId,
        name: bucketName,
        parentId: null,
        s3PublicAccess: true,
        deletedAt: null,
      },
      select: { id: true, s3PublicListObjects: true },
    });
    if (!bucket) throw new NotFoundException('NoSuchBucket');

    if (!bucket.s3PublicListObjects) {
      throw new ForbiddenException('AccessDenied');
    }

    const objects: Array<{
      key: string;
      size: bigint;
      lastModified: Date;
      etag: string;
    }> = [];
    const commonPrefixes = new Set<string>();

    await this.listRecursiveOptimized(
      userId,
      bucket.id,
      prefix || '',
      delimiter,
      objects,
      commonPrefixes,
      Number.MAX_SAFE_INTEGER,
    );

    objects.sort((a, b) => a.key.localeCompare(b.key));
    const sortedCommonPrefixes = [...commonPrefixes].sort((a, b) =>
      a.localeCompare(b),
    );

    return {
      objects: objects.slice(0, maxKeys),
      commonPrefixes: sortedCommonPrefixes,
    };
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
    objects: Array<{
      key: string;
      size: bigint;
      lastModified: Date;
      etag: string;
    }>;
    commonPrefixes: string[];
  }> {
    const bucket = await this.prisma.folder.findFirst({
      where: { userId, name: bucketName, parentId: null, deletedAt: null },
    });
    if (!bucket) throw new NotFoundException('NoSuchBucket');

    const objects: Array<{
      key: string;
      size: bigint;
      lastModified: Date;
      etag: string;
    }> = [];
    const commonPrefixes = new Set<string>();

    await this.listRecursiveOptimized(
      userId,
      bucket.id,
      prefix || '',
      delimiter,
      objects,
      commonPrefixes,
      Number.MAX_SAFE_INTEGER,
    );

    objects.sort((a, b) => a.key.localeCompare(b.key));
    const sortedCommonPrefixes = [...commonPrefixes].sort((a, b) =>
      a.localeCompare(b),
    );

    return {
      objects: objects.slice(0, maxKeys),
      commonPrefixes: sortedCommonPrefixes,
    };
  }

  private async listRecursiveOptimized(
    userId: string,
    bucketId: string,
    prefix: string,
    delimiter: string | undefined,
    objects: Array<{
      key: string;
      size: bigint;
      lastModified: Date;
      etag: string;
    }>,
    commonPrefixes: Set<string>,
    maxKeys: number,
  ): Promise<void> {
    // 1. Fetch all active folders for the user
    const folders = await this.prisma.folder.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, name: true, parentId: true, updatedAt: true },
    });

    // 2. Build map and children structure in memory
    const folderMap = new Map<string, (typeof folders)[0]>();
    const childrenMap = new Map<string, (typeof folders)[0][]>();
    for (const f of folders) {
      folderMap.set(f.id, f);
      if (f.parentId) {
        const list = childrenMap.get(f.parentId) || [];
        list.push(f);
        childrenMap.set(f.parentId, list);
      }
    }

    // 3. Compute relative paths starting from bucketId
    const folderPathMap = new Map<string, string>(); // folderId -> relative path
    const descendantFolderIds = new Set<string>();
    descendantFolderIds.add(bucketId);
    folderPathMap.set(bucketId, '');

    const queue = [bucketId];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const currentPath = folderPathMap.get(currentId)!;
      const children = childrenMap.get(currentId) || [];
      for (const child of children) {
        const childPath = currentPath
          ? `${currentPath}/${child.name}`
          : child.name;
        folderPathMap.set(child.id, childPath);
        descendantFolderIds.add(child.id);
        queue.push(child.id);
      }
    }

    // 4. Fetch all active complete files under the descendant folders
    const files = await this.prisma.fileRecord.findMany({
      where: {
        userId,
        folderId: { in: Array.from(descendantFolderIds) },
        deletedAt: null,
        status: 'complete',
      },
      select: {
        folderId: true,
        filename: true,
        size: true,
        createdAt: true,
        updatedAt: true,
        id: true,
        etag: true,
      },
    });

    // Group files by folderId
    const filesByFolder = new Map<string, typeof files>();
    for (const file of files) {
      const fId = file.folderId || bucketId;
      const list = filesByFolder.get(fId) || [];
      list.push(file);
      filesByFolder.set(fId, list);
    }

    // 5. In-memory recursive traversal matching the original logic
    const traverse = (folderId: string, currentPath: string): void => {
      if (objects.length >= maxKeys) return;

      // List files in current folder
      const folderFiles = filesByFolder.get(folderId) || [];
      for (const file of folderFiles) {
        const key = currentPath
          ? `${currentPath}/${file.filename}`
          : file.filename;

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
          lastModified: file.createdAt,
          etag: file.etag || `"${file.id}"`,
        });
      }

      if (objects.length >= maxKeys) return;

      // List subfolders
      const subFolders = childrenMap.get(folderId) || [];
      for (const folder of subFolders) {
        const folderPath = currentPath
          ? `${currentPath}/${folder.name}`
          : folder.name;
        const fullPath = `${folderPath}/`;

        if (
          prefix &&
          !fullPath.startsWith(prefix) &&
          !prefix.startsWith(fullPath)
        ) {
          continue;
        }

        if (delimiter) {
          // Prefix is deeper than this folder, keep traversing down to it.
          if (prefix && prefix.startsWith(fullPath)) {
            traverse(folder.id, folderPath);
            continue;
          }

          // Collapse folder path to CommonPrefixes for delimiter-based listing.
          const rest = fullPath.substring(prefix.length);
          const delimIdx = rest.indexOf(delimiter);
          if (delimIdx !== -1) {
            commonPrefixes.add(prefix + rest.substring(0, delimIdx + 1));
            continue;
          }
        }

        // No delimiter (recursive mode): check if folder is an empty leaf.
        if (!delimiter) {
          const hasChild = (childrenMap.get(folder.id) || []).length > 0;
          const hasFile = (filesByFolder.get(folder.id) || []).length > 0;

          if (!hasChild && !hasFile) {
            if (!prefix || fullPath.startsWith(prefix)) {
              objects.push({
                key: fullPath,
                size: BigInt(0),
                lastModified: folder.updatedAt,
                etag: `"${folder.id}"`,
              });
            }
            continue;
          }
        }

        traverse(folder.id, folderPath);
      }
    };

    traverse(bucketId, '');
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
      keys.push(decodeXmlEntities(match[1]));
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
      : deleted
          .map((item) => `<Deleted><Key>${escapeXml(item.key)}</Key></Deleted>`)
          .join('');

    const errorsXml = errors
      .map(
        (item) =>
          `<Error><Key>${escapeXml(item.key)}</Key><Code>${escapeXml(item.code)}</Code><Message>${escapeXml(item.message)}</Message></Error>`,
      )
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?>\n<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deletedXml}${errorsXml}</DeleteResult>`;
  }

  buildListBucketsXml(
    buckets: Array<{ name: string; createdAt: Date }>,
    owner: string,
  ): string {
    const bucketsXml = buckets
      .map(
        (b) => `
    <Bucket>
      <Name>${escapeXml(b.name)}</Name>
      <CreationDate>${b.createdAt.toISOString()}</CreationDate>
    </Bucket>`,
      )
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner>
    <ID>${escapeXml(owner)}</ID>
    <DisplayName>${escapeXml(owner)}</DisplayName>
  </Owner>
  <Buckets>${bucketsXml}
  </Buckets>
</ListAllMyBucketsResult>`;
  }

  buildListObjectsV2Xml(
    bucketName: string,
    objects: Array<{
      key: string;
      size: bigint;
      lastModified: Date;
      etag: string;
    }>,
    commonPrefixes: string[],
    prefix: string,
    delimiter: string,
    maxKeys: number,
    isTruncated: boolean,
    encodingType?: string,
  ): string {
    const shouldUrlEncode = encodingType === 'url';
    const encodeValue = (value: string) =>
      shouldUrlEncode ? this.encodeS3ListValue(value) : value;
    const keyCount = objects.length + commonPrefixes.length;

    const objectsXml = objects
      .map(
        (o) => `
  <Contents>
    <Key>${escapeXml(encodeValue(o.key))}</Key>
    <LastModified>${o.lastModified.toISOString()}</LastModified>
    <ETag>${escapeXml(o.etag)}</ETag>
    <Size>${o.size}</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>`,
      )
      .join('');

    const prefixesXml = commonPrefixes
      .map(
        (p) =>
          `\n  <CommonPrefixes><Prefix>${escapeXml(encodeValue(p))}</Prefix></CommonPrefixes>`,
      )
      .join('');

    const encodingTypeXml = shouldUrlEncode
      ? `\n  <EncodingType>url</EncodingType>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escapeXml(bucketName)}</Name>
  <Prefix>${escapeXml(encodeValue(prefix))}</Prefix>
  <KeyCount>${keyCount}</KeyCount>
  <MaxKeys>${maxKeys}</MaxKeys>
  <Delimiter>${escapeXml(encodeValue(delimiter))}</Delimiter>${encodingTypeXml}
  <IsTruncated>${isTruncated}</IsTruncated>${objectsXml}${prefixesXml}
</ListBucketResult>`;
  }

  private encodeS3ListValue(value: string): string {
    return encodeURIComponent(value).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  }

  buildErrorXml(code: string, message: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>${escapeXml(code)}</Code>
  <Message>${escapeXml(message)}</Message>
</Error>`;
  }
}
