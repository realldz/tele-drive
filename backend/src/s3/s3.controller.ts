import {
  Controller,
  Logger,
  Get,
  Put,
  Delete,
  Head,
  Post,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { S3AuthGuard } from './s3-auth.guard';
import { S3Service } from './s3.service';
import { S3MultipartService } from './s3-multipart.service';
import { FileService } from '../file/file.service';
import { TelegramService } from '../telegram/telegram.service';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../auth/public.decorator';
import { MAX_CHUNK_SIZE } from '../config/upload.config';
import type { Request, Response } from 'express';
import { Readable, Transform } from 'stream';
import * as crypto from 'crypto';

/**
 * S3Controller — S3-compatible API Gateway.
 *
 * Full routing map (query params disambiguate operations on the same method+path):
 *
 *  GET    /s3/                                    → ListBuckets
 *  PUT    /s3/:bucket                             → CreateBucket
 *  HEAD   /s3/:bucket                             → HeadBucket (200 if exists, 404 otherwise)
 *  DELETE /s3/:bucket                             → DeleteBucket
 *  GET    /s3/:bucket                             → ListObjectsV2 (or V1)
 *
 *  PUT    /s3/:bucket/*  (no extra params)        → PutObject
 *  PUT    /s3/:bucket/*  (?partNumber=N&uploadId) → UploadPart
 *  PUT    /s3/:bucket/*  (x-amz-copy-source hdr)  → CopyObject   [Task 7]
 *
 *  POST   /s3/:bucket/*  (?uploads)               → CreateMultipartUpload
 *  POST   /s3/:bucket/*  (?uploadId=X)            → CompleteMultipartUpload
 *
 *  GET    /s3/:bucket/*  (no uploadId)            → GetObject
 *  GET    /s3/:bucket/*  (?uploadId=X)            → ListParts
 *
 *  HEAD   /s3/:bucket/*                           → HeadObject
 *
 *  DELETE /s3/:bucket/*  (no uploadId)            → DeleteObject
 *  DELETE /s3/:bucket/*  (?uploadId=X)            → AbortMultipartUpload
 *
 * All routes use @Public() to skip the global JwtAuthGuard, and
 * @UseGuards(S3AuthGuard) to enforce AWS Signature V4 instead.
 *
 * ETag policy:
 *   - PutObject  (single):    MD5 of plaintext content — stored in FileRecord.etag
 *   - UploadPart:             MD5 of plaintext part    — stored in FileChunk.etag
 *   - CompleteMultipartUpload: MD5(concat(raw part md5s)) + "-N" — stored in FileRecord.etag
 *   - CopyObject:             inherits source FileRecord.etag
 *   - GetObject / HeadObject: return FileRecord.etag if set, else `"<fileId>"`
 *
 * Content-MD5 verification:
 *   - If client sends `Content-MD5: <base64>` on PutObject, we verify it against
 *     the received body's MD5. Mismatch → 400 BadDigest.   [Task 8]
 */
@Public()
@UseGuards(S3AuthGuard)
@Controller('s3')
export class S3Controller {
  private readonly logger = new Logger(S3Controller.name);

  constructor(
    private readonly s3Service: S3Service,
    private readonly s3Multipart: S3MultipartService,
    private readonly fileService: FileService,
    private readonly telegramService: TelegramService,
    private readonly cryptoService: CryptoService,
    private readonly prisma: PrismaService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /s3/ → ListBuckets
  // ---------------------------------------------------------------------------

  @Get()
  async listBuckets(@Req() req: Request, @Res() res: Response) {
    const userId = (req as any).s3UserId as string;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });

    const buckets = await this.s3Service.listBuckets(userId);
    const xml = this.s3Service.buildListBucketsXml(
      buckets.map((b) => ({ name: b.name, createdAt: b.createdAt })),
      user?.username || userId,
    );

    this.setRequestId(res);
    res.setHeader('Content-Type', 'application/xml');
    res.status(200).send(xml);
  }

  // ---------------------------------------------------------------------------
  // Bucket-level operations
  // ---------------------------------------------------------------------------

  /** PUT /s3/:bucket → CreateBucket */
  @Put(':bucket')
  async createBucket(
    @Param('bucket') bucket: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const userId = (req as any).s3UserId as string;
    await this.s3Service.createBucket(userId, bucket);
    this.setRequestId(res);
    res.setHeader('Location', `/${bucket}`);
    res.status(200).end();
  }

  /**
   * HEAD /s3/:bucket → HeadBucket
   * aws-cli checks this before any bucket operation. Returns 200 if bucket
   * exists and belongs to user, 404 otherwise.
   */
  @Head(':bucket')
  async headBucket(
    @Param('bucket') bucket: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const userId = (req as any).s3UserId as string;
    const exists = await this.prisma.folder.findFirst({
      where: { userId, name: bucket, parentId: null, deletedAt: null },
      select: { id: true },
    });
    this.setRequestId(res);
    res.status(exists ? 200 : 404).end();
  }

  /** DELETE /s3/:bucket → DeleteBucket */
  @Delete(':bucket')
  async deleteBucket(
    @Param('bucket') bucket: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const userId = (req as any).s3UserId as string;
    this.setRequestId(res);
    try {
      await this.s3Service.deleteBucket(userId, bucket);
      res.status(204).end();
    } catch (err: any) {
      const code = err.message || 'InternalError';
      res
        .status(err.status || 409)
        .setHeader('Content-Type', 'application/xml')
        .send(this.s3Service.buildErrorXml(code, code));
    }
  }

  /**
   * GET /s3/:bucket → ListObjectsV2 (handles both list-type=1 and list-type=2)
   */
  @Get(':bucket')
  async listObjects(
    @Param('bucket') bucket: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const userId = (req as any).s3UserId as string;
    const query = req.query as Record<string, string>;
    const prefix = query['prefix'] || '';
    const delimiter = query['delimiter'] || '';
    const maxKeys = Math.min(parseInt(query['max-keys'] || '1000', 10), 1000);

    this.setRequestId(res);
    try {
      const { objects, commonPrefixes } = await this.s3Service.listObjects(
        userId,
        bucket,
        prefix,
        delimiter || undefined,
        maxKeys,
      );

      const isTruncated = objects.length >= maxKeys;
      const xml = this.s3Service.buildListObjectsV2Xml(
        bucket,
        objects,
        commonPrefixes,
        prefix,
        delimiter,
        maxKeys,
        isTruncated,
      );

      res.setHeader('Content-Type', 'application/xml');
      res.status(200).send(xml);
    } catch (err: any) {
      this.sendS3Error(res, err);
    }
  }

  // ---------------------------------------------------------------------------
  // PUT /s3/:bucket/* — PutObject / UploadPart / CopyObject
  // ---------------------------------------------------------------------------

  @Put(':bucket/*')
  async handlePut(
    @Param('bucket') bucket: string,
    @Param() params: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const userId = (req as any).s3UserId as string;
    const key = params['0'] as string;
    const query = req.query as Record<string, string>;

    this.setRequestId(res);

    // --- CopyObject (Task 7) ---
    // aws-cli URL-encodes the copy-source path, e.g. "my%2Dbucket/path/file.txt"
    const rawCopySource = req.headers['x-amz-copy-source'] as string | undefined;
    if (rawCopySource) {
      const copySource = decodeURIComponent(rawCopySource);
      return this.doCopyObject(userId, bucket, key, copySource, res);
    }

    // --- UploadPart ---
    const uploadId = query['uploadId'];
    const partNumberStr = query['partNumber'];
    if (uploadId && partNumberStr) {
      const partNumber = parseInt(partNumberStr, 10);
      try {
        const { etag } = await this.s3Multipart.uploadPart(
          uploadId,
          partNumber,
          userId,
          req as unknown as Readable,
        );
        res.setHeader('ETag', etag);
        res.status(200).end();
      } catch (err: any) {
        this.logger.error(`S3 UploadPart error: ${err.message}`, err.stack);
        this.sendS3Error(res, err);
      }
      return;
    }

    // --- PutObject (default) ---
    return this.doPutObject(userId, bucket, key, req, res);
  }

  // ---------------------------------------------------------------------------
  // POST /s3/:bucket/* — CreateMultipartUpload / CompleteMultipartUpload
  // ---------------------------------------------------------------------------

  @Post(':bucket/*')
  async handlePost(
    @Param('bucket') bucket: string,
    @Param() params: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const userId = (req as any).s3UserId as string;
    const key = params['0'] as string;
    const query = req.query as Record<string, string>;

    this.setRequestId(res);

    // --- CreateMultipartUpload ---
    if ('uploads' in query) {
      const contentType =
        (req.headers['content-type'] as string) || 'application/octet-stream';
      try {
        const { uploadId } = await this.s3Multipart.createMultipartUpload(
          userId,
          bucket,
          key,
          contentType,
        );
        const xml = this.s3Multipart.buildInitiateMultipartUploadXml(bucket, key, uploadId);
        res.setHeader('Content-Type', 'application/xml');
        res.status(200).send(xml);
      } catch (err: any) {
        this.logger.error(`S3 CreateMultipartUpload error: ${err.message}`, err.stack);
        this.sendS3Error(res, err);
      }
      return;
    }

    // --- CompleteMultipartUpload ---
    const uploadId = query['uploadId'];
    if (uploadId) {
      try {
        const bodyBuf = await this.readBody(req as unknown as Readable);
        const bodyStr = bodyBuf.toString('utf8');
        const partCount = this.s3Multipart.parseCompleteMultipartXml(bodyStr);

        const { location, etag } = await this.s3Multipart.completeMultipartUpload(
          uploadId,
          userId,
          partCount,
        );

        const xml = this.s3Multipart.buildCompleteMultipartUploadXml(
          bucket,
          key,
          location,
          etag,
        );
        res.setHeader('Content-Type', 'application/xml');
        res.setHeader('ETag', etag);
        res.status(200).send(xml);
      } catch (err: any) {
        this.logger.error(`S3 CompleteMultipartUpload error: ${err.message}`, err.stack);
        this.sendS3Error(res, err);
      }
      return;
    }

    res
      .status(400)
      .setHeader('Content-Type', 'application/xml')
      .send(this.s3Service.buildErrorXml('InvalidRequest', 'Unknown POST operation'));
  }

  // ---------------------------------------------------------------------------
  // GET /s3/:bucket/* — GetObject / ListParts
  // ---------------------------------------------------------------------------

  @Get(':bucket/*')
  async handleGet(
    @Param('bucket') bucket: string,
    @Param() params: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const userId = (req as any).s3UserId as string;
    const key = params['0'] as string;
    const query = req.query as Record<string, string>;

    this.setRequestId(res);

    // --- ListParts ---
    const uploadId = query['uploadId'];
    if (uploadId) {
      try {
        const parts = await this.s3Multipart.listParts(uploadId, userId);
        const xml = this.s3Multipart.buildListPartsXml(bucket, key, uploadId, parts);
        res.setHeader('Content-Type', 'application/xml');
        res.status(200).send(xml);
      } catch (err: any) {
        this.sendS3Error(res, err);
      }
      return;
    }

    // --- GetObject ---
    this.logger.log(`S3 GetObject: s3://${bucket}/${key} (userId: ${userId})`);
    try {
      const file = await this.s3Service.findObject(userId, bucket, key);
      const downloadInfo = await this.fileService.resolveDownloadUrls(file);

      const etag = (file as any).etag || `"${file.id}"`;
      res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', file.size.toString());
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', file.updatedAt.toUTCString());
      res.setHeader('Accept-Ranges', 'bytes');

      const rangeHeader = req.headers['range'] as string | undefined;
      if (rangeHeader) {
        return this.fileService.processStream(downloadInfo, rangeHeader, res);
      }
      return this.fileService.processDownload(downloadInfo, res);
    } catch (err: any) {
      this.logger.error(`S3 GetObject error: ${err.message}`);
      this.sendS3Error(res, err);
    }
  }

  // ---------------------------------------------------------------------------
  // HEAD /s3/:bucket/* — HeadObject
  // ---------------------------------------------------------------------------

  @Head(':bucket/*')
  async headObject(
    @Param('bucket') bucket: string,
    @Param() params: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const userId = (req as any).s3UserId as string;
    const key = params['0'] as string;

    this.logger.log(`S3 HeadObject: s3://${bucket}/${key} (userId: ${userId})`);
    this.setRequestId(res);

    try {
      const file = await this.s3Service.findObject(userId, bucket, key);
      const etag = (file as any).etag || `"${file.id}"`;

      res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', file.size.toString());
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', file.updatedAt.toUTCString());
      res.setHeader('Accept-Ranges', 'bytes');
      res.status(200).end();
    } catch (err: any) {
      this.logger.warn(`S3 HeadObject not found: s3://${bucket}/${key}`);
      res
        .status(err.status || 404)
        .setHeader('Content-Type', 'application/xml')
        .send(
          this.s3Service.buildErrorXml('NoSuchKey', 'The specified key does not exist.'),
        );
    }
  }

  // ---------------------------------------------------------------------------
  // DELETE /s3/:bucket/* — DeleteObject / AbortMultipartUpload
  // ---------------------------------------------------------------------------

  @Delete(':bucket/*')
  async handleDelete(
    @Param('bucket') bucket: string,
    @Param() params: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const userId = (req as any).s3UserId as string;
    const key = params['0'] as string;
    const query = req.query as Record<string, string>;

    this.setRequestId(res);

    // --- AbortMultipartUpload ---
    const uploadId = query['uploadId'];
    if (uploadId) {
      try {
        await this.s3Multipart.abortMultipartUpload(uploadId, userId);
        res.status(204).end();
      } catch (err: any) {
        this.sendS3Error(res, err);
      }
      return;
    }

    // --- DeleteObject ---
    this.logger.log(`S3 DeleteObject: s3://${bucket}/${key} (userId: ${userId})`);
    try {
      const file = await this.s3Service.findObject(userId, bucket, key);
      await this.fileService.delete(file.id, userId);
      res.status(204).end();
    } catch (err: any) {
      // S3 spec: DeleteObject returns 204 even if key doesn't exist
      if (err.status === 404 || err.message === 'NoSuchKey') {
        res.status(204).end();
      } else {
        this.sendS3Error(res, err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // PutObject — single-shot upload with ETag + Content-MD5 verification
  // ---------------------------------------------------------------------------

  private async doPutObject(
    userId: string,
    bucket: string,
    key: string,
    req: Request,
    res: Response,
  ) {
    const contentLength = parseInt(
      (req.headers['content-length'] as string) || '0',
      10,
    );
    const contentType =
      (req.headers['content-type'] as string) || 'application/octet-stream';
    // Content-MD5 header (base64-encoded MD5 of body sent by client)
    const contentMd5Header = req.headers['content-md5'] as string | undefined;
    const filename = key.split('/').pop() || key;

    this.logger.log(
      `S3 PutObject: s3://${bucket}/${key} (${contentLength} bytes, userId: ${userId})`,
    );

    try {
      const { folderId } = await this.s3Service.resolveKey(userId, bucket, key, true);
      await (this.fileService as any).checkQuota(userId, contentLength || 0);

      const dek = this.cryptoService.generateFileKey();
      const iv = this.cryptoService.generateIv();
      const encryptedKey = this.cryptoService.encryptKey(dek);

      if (contentLength > 0 && contentLength <= MAX_CHUNK_SIZE) {
        // ── Small file path: buffer → verify Content-MD5 → encrypt → upload ──
        const bodyBuffer = await this.readBody(req as unknown as Readable);
        const computedMd5Hex = crypto.createHash('md5').update(bodyBuffer).digest('hex');

        // Content-MD5 verification (Task 8)
        if (contentMd5Header) {
          const expectedMd5Hex = Buffer.from(contentMd5Header, 'base64').toString('hex');
          if (expectedMd5Hex !== computedMd5Hex) {
            this.logger.warn(
              `S3 PutObject BadDigest: expected ${expectedMd5Hex}, got ${computedMd5Hex}`,
            );
            return res
              .status(400)
              .setHeader('Content-Type', 'application/xml')
              .send(
                this.s3Service.buildErrorXml(
                  'BadDigest',
                  'The Content-MD5 you specified did not match what we received.',
                ),
              );
          }
        }

        const etag = `"${computedMd5Hex}"`;

        const cipher = this.cryptoService.createEncryptStream(dek, iv);
        const encryptedBuffer = Buffer.concat([cipher.update(bodyBuffer), cipher.final()]);

        const record = await this.prisma.fileRecord.create({
          data: {
            filename,
            size: bodyBuffer.length,
            mimeType: contentType,
            status: 'uploading',
            isEncrypted: true,
            encryptionAlgo: 'aes-256-ctr',
            encryptionIv: iv.toString('hex'),
            encryptedKey,
            etag,
            folderId: folderId || null,
            userId,
          },
        });

        const { fileId: telegramFileId, messageId: telegramMessageId } =
          await this.telegramService.uploadFile(encryptedBuffer, record.id);

        await this.prisma.$transaction(async (tx) => {
          await tx.fileRecord.update({
            where: { id: record.id },
            data: { telegramFileId, telegramMessageId, status: 'complete' },
          });
          await tx.user.update({
            where: { id: userId },
            data: { usedSpace: { increment: bodyBuffer.length } },
          });
        });

        this.logger.log(
          `S3 PutObject complete: s3://${bucket}/${key} (${bodyBuffer.length} bytes, ETag: ${etag})`,
        );
        res.setHeader('ETag', etag);
        res.status(200).end();
      } else {
        // ── Large file: streaming path — compute MD5 on the fly ─────────────
        const record = await this.prisma.fileRecord.create({
          data: {
            filename,
            size: contentLength || 0,
            mimeType: contentType,
            status: 'uploading',
            isEncrypted: true,
            encryptionAlgo: 'aes-256-ctr',
            encryptionIv: iv.toString('hex'),
            encryptedKey,
            folderId: folderId || null,
            userId,
          },
        });

        let totalBytes = 0;
        const md5 = crypto.createHash('md5');

        const counterTransform = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            totalBytes += chunk.length;
            md5.update(chunk);
            cb(null, chunk);
          },
        });

        const cipherStream = this.cryptoService.createEncryptStream(dek, iv);
        const uploadStream = (req as unknown as Readable)
          .pipe(counterTransform)
          .pipe(cipherStream);

        const { fileId: telegramFileId, messageId: telegramMessageId } =
          await this.telegramService.uploadStream(uploadStream, record.id);

        const etag = `"${md5.digest('hex')}"`;

        await this.prisma.$transaction(async (tx) => {
          await tx.fileRecord.update({
            where: { id: record.id },
            data: {
              telegramFileId,
              telegramMessageId,
              status: 'complete',
              size: totalBytes,
              etag,
            },
          });
          await tx.user.update({
            where: { id: userId },
            data: { usedSpace: { increment: totalBytes } },
          });
        });

        this.logger.log(
          `S3 PutObject streamed: s3://${bucket}/${key} (${totalBytes} bytes, ETag: ${etag})`,
        );
        res.setHeader('ETag', etag);
        res.status(200).end();
      }
    } catch (err: any) {
      this.logger.error(`S3 PutObject error: ${err.message}`, err.stack);
      this.sendS3Error(res, err);
    }
  }

  // ---------------------------------------------------------------------------
  // CopyObject — Task 7
  // ---------------------------------------------------------------------------

  private async doCopyObject(
    userId: string,
    destBucket: string,
    destKey: string,
    copySource: string, // already URL-decoded by caller
    res: Response,
  ) {
    // Format: /sourceBucket/sourceKey  or  sourceBucket/sourceKey
    const cleanSource = copySource.startsWith('/') ? copySource.slice(1) : copySource;
    const slashIdx = cleanSource.indexOf('/');
    if (slashIdx === -1) {
      return this.sendS3Error(res, { status: 400, message: 'InvalidArgument' });
    }

    const sourceBucket = cleanSource.substring(0, slashIdx);
    const sourceKey = cleanSource.substring(slashIdx + 1);

    // Guard: source === destination is a no-op (S3 allows it, returns 200)
    if (sourceBucket === destBucket && sourceKey === destKey) {
      try {
        const file = await this.s3Service.findObject(userId, sourceBucket, sourceKey);
        const etag = (file as any).etag || `"${file.id}"`;
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <LastModified>${file.updatedAt.toISOString()}</LastModified>
  <ETag>${etag}</ETag>
</CopyObjectResult>`;
        res.setHeader('Content-Type', 'application/xml');
        res.setHeader('ETag', etag);
        return res.status(200).send(xml);
      } catch (err: any) {
        return this.sendS3Error(res, err);
      }
    }

    this.logger.log(
      `S3 CopyObject: s3://${sourceBucket}/${sourceKey} → s3://${destBucket}/${destKey} (userId: ${userId})`,
    );

    try {
      const sourceFile = await this.s3Service.findObject(userId, sourceBucket, sourceKey);
      const { folderId } = await this.s3Service.resolveKey(userId, destBucket, destKey, true);
      const filename = destKey.split('/').pop() || destKey;

      // Inherit source ETag
      const inheritedEtag = (sourceFile as any).etag || `"${sourceFile.id}"`;

      // Clone FileRecord — shares the same Telegram fileId (no re-download)
      const newRecord = await this.prisma.fileRecord.create({
        data: {
          filename,
          size: sourceFile.size,
          mimeType: sourceFile.mimeType,
          telegramFileId: sourceFile.telegramFileId,
          telegramMessageId: sourceFile.telegramMessageId,
          isChunked: sourceFile.isChunked,
          totalChunks: sourceFile.totalChunks,
          status: 'complete',
          isEncrypted: sourceFile.isEncrypted,
          encryptionAlgo: sourceFile.encryptionAlgo,
          encryptionIv: sourceFile.encryptionIv,
          encryptedKey: sourceFile.encryptedKey,
          etag: inheritedEtag,
          folderId: folderId || null,
          userId,
        },
      });

      await this.prisma.user.update({
        where: { id: userId },
        data: { usedSpace: { increment: sourceFile.size } },
      });

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <LastModified>${newRecord.createdAt.toISOString()}</LastModified>
  <ETag>${inheritedEtag}</ETag>
</CopyObjectResult>`;

      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('ETag', inheritedEtag);
      res.status(200).send(xml);
    } catch (err: any) {
      this.sendS3Error(res, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Buffer entire stream. Used for small PutObject bodies and XML payloads. */
  private readBody(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  /** Add x-amz-request-id to every response for aws-cli compatibility. */
  private setRequestId(res: Response) {
    res.setHeader('x-amz-request-id', crypto.randomBytes(8).toString('hex').toUpperCase());
    res.setHeader('x-amz-id-2', crypto.randomBytes(16).toString('base64'));
  }

  private sendS3Error(res: Response, err: any) {
    const statusMap: Record<string, number> = {
      NoSuchBucket: 404,
      NoSuchKey: 404,
      BucketNotEmpty: 409,
      InvalidArgument: 400,
      BadDigest: 400,
      AccessDenied: 403,
      InvalidRequest: 400,
    };
    const code = err.message || 'InternalError';
    const status = err.status || statusMap[code] || 500;
    res
      .status(status)
      .setHeader('Content-Type', 'application/xml')
      .send(
        this.s3Service.buildErrorXml(code, err.message || 'An internal error occurred.'),
      );
  }
}
