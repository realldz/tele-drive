import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { CryptoService } from '../crypto/crypto.service';
import { S3Service } from './s3.service';
import { Transform, Readable } from 'stream';
import * as crypto from 'crypto';

/**
 * S3MultipartService — maps S3 Multipart Upload API to Tele-Drive chunked upload.
 *
 * Mapping:
 *   CreateMultipartUpload  →  initChunkedUpload (creates FileRecord, returns uploadId = fileId)
 *   UploadPart             →  raw-stream upload to Telegram, creates FileChunk record
 *   CompleteMultipartUpload→  completeChunkedUpload (sets status=complete, updates usedSpace)
 *   AbortMultipartUpload   →  abortUpload (deletes Telegram chunks + FileRecord)
 *   ListParts              →  getUploadedChunks (returns uploaded chunk indexes)
 *
 * Key design decisions:
 *   - uploadId  = fileId (FileRecord.id) — no separate mapping table needed
 *   - partNumber is 1-based (S3 standard) → chunkIndex = partNumber - 1 (0-based)
 *   - totalChunks is set to a large sentinel (10_000) on init; updated to actual
 *     part count when CompleteMultipartUpload is called, before marking complete
 *   - Each UploadPart raw-streams the request body through AES-256-CTR → Telegram
 *     (no Busboy multipart/form-data parsing — S3 parts are raw binary)
 */
@Injectable()
export class S3MultipartService {
  private readonly logger = new Logger(S3MultipartService.name);

  // Sentinel value for totalChunks during in-progress multipart upload
  private readonly SENTINEL_TOTAL_CHUNKS = 10_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramService: TelegramService,
    private readonly cryptoService: CryptoService,
    private readonly s3Service: S3Service,
  ) {}

  // ---------------------------------------------------------------------------
  // CreateMultipartUpload
  // ---------------------------------------------------------------------------

  /**
   * POST /s3/:bucket/*key?uploads → CreateMultipartUpload
   *
   * Initialises a FileRecord in 'uploading' status and returns uploadId (= fileId).
   * Content-Length is unknown at this point, so we set size=0 and update on complete.
   */
  async createMultipartUpload(
    userId: string,
    bucket: string,
    key: string,
    contentType: string,
  ): Promise<{ uploadId: string }> {
    this.logger.log(
      `S3 CreateMultipartUpload: s3://${bucket}/${key} (userId: ${userId})`,
    );

    const filename = key.split('/').pop() || key;

    // Resolve / auto-create folder path under the bucket
    const { folderId } = await this.s3Service.resolveKey(userId, bucket, key, true);

    // Generate encryption material upfront (same DEK used for all chunks)
    const dek = this.cryptoService.generateFileKey();
    const iv = this.cryptoService.generateIv();
    const encryptedKey = this.cryptoService.encryptKey(dek);

    const record = await this.prisma.fileRecord.create({
      data: {
        filename,
        size: 0, // Updated when CompleteMultipartUpload is called
        mimeType: contentType || 'application/octet-stream',
        isChunked: true,
        totalChunks: this.SENTINEL_TOTAL_CHUNKS,
        status: 'uploading',
        isEncrypted: true,
        encryptionAlgo: 'aes-256-ctr',
        encryptionIv: iv.toString('hex'),
        encryptedKey,
        folderId: folderId || null,
        userId,
      },
    });

    this.logger.log(
      `S3 Multipart initiated: uploadId=${record.id}, s3://${bucket}/${key}`,
    );

    return { uploadId: record.id };
  }

  // ---------------------------------------------------------------------------
  // UploadPart
  // ---------------------------------------------------------------------------

  /**
   * PUT /s3/:bucket/*key?partNumber=N&uploadId=X → UploadPart
   *
   * Streams raw request body through AES-256-CTR → Telegram.
   * Each part gets its own IV (chunk-level encryption).
   * Returns ETag = MD5 of the plaintext part data.
   */
  async uploadPart(
    uploadId: string,
    partNumber: number,
    userId: string,
    req: Readable,
  ): Promise<{ etag: string; size: number }> {
    // partNumber is 1-based; chunkIndex is 0-based
    const chunkIndex = partNumber - 1;

    if (partNumber < 1 || partNumber > 10_000) {
      throw new BadRequestException(
        `Invalid part number ${partNumber}. Must be 1-10000.`,
      );
    }

    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: uploadId, userId, status: 'uploading' },
    });
    if (!fileRecord) {
      throw new NotFoundException(
        `Upload not found or already completed: uploadId=${uploadId}`,
      );
    }

    // Idempotency: if chunk already exists, return its stored ETag
    const existing = await this.prisma.fileChunk.findUnique({
      where: { fileId_chunkIndex: { fileId: uploadId, chunkIndex } },
    });
    if (existing) {
      this.logger.debug(
        `UploadPart idempotent: part ${partNumber} already exists for uploadId ${uploadId}`,
      );
      // Drain the stream
      req.resume();
      // Return stored etag if available, otherwise derive a stable one
      const storedEtag = (existing as any).etag ||
        `"${crypto.createHash('md5').update(String(chunkIndex)).digest('hex')}"`;
      return { etag: storedEtag, size: existing.size };
    }

    // Decrypt the DEK for this upload
    const dek = this.cryptoService.decryptKey(fileRecord.encryptedKey!);
    const chunkIv = this.cryptoService.generateIv();

    this.logger.log(
      `S3 UploadPart: uploadId=${uploadId}, part=${partNumber} (chunkIndex=${chunkIndex})`,
    );

    // Use record id as chunk filename to avoid leaking the real filename on Telegram
    const chunkFilename = `${fileRecord.id}.part${String(chunkIndex).padStart(4, '0')}`;

    // Track bytes + compute plaintext MD5 for ETag
    let totalBytes = 0;
    const md5 = crypto.createHash('md5');

    const counterTransform = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        totalBytes += chunk.length;
        md5.update(chunk);
        cb(null, chunk);
      },
    });

    const cipherStream = this.cryptoService.createEncryptStream(dek, chunkIv);
    const uploadStream = req.pipe(counterTransform).pipe(cipherStream);

    const { fileId: telegramFileId, messageId: telegramMessageId } =
      await this.telegramService.uploadStream(uploadStream, chunkFilename);

    // Persist the chunk record — store MD5 etag for multipart ETag computation later
    const partMd5Hex = md5.digest('hex');
    const etag = `"${partMd5Hex}"`;

    await this.prisma.fileChunk.create({
      data: {
        fileId: uploadId,
        chunkIndex,
        size: totalBytes,
        telegramFileId,
        telegramMessageId,
        encryptionIv: chunkIv.toString('hex'),
        etag,
      },
    });
    this.logger.log(
      `S3 UploadPart complete: uploadId=${uploadId}, part=${partNumber}, size=${totalBytes}, ETag=${etag}`,
    );

    return { etag, size: totalBytes };
  }

  // ---------------------------------------------------------------------------
  // CompleteMultipartUpload
  // ---------------------------------------------------------------------------

  /**
   * POST /s3/:bucket/*key?uploadId=X → CompleteMultipartUpload
   *
   * The client sends an XML body listing all parts with their ETags.
   * We verify all expected parts are uploaded, then mark the FileRecord complete.
   *
   * @param partCount  number of parts declared by the client (parsed from XML body)
   */
  async completeMultipartUpload(
    uploadId: string,
    userId: string,
    declaredPartCount: number,
  ): Promise<{ location: string; etag: string }> {
    this.logger.log(
      `S3 CompleteMultipartUpload: uploadId=${uploadId}, declaredParts=${declaredPartCount}`,
    );

    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: uploadId, userId },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord) throw new NotFoundException(`Upload not found: uploadId=${uploadId}`);
    if (fileRecord.status === 'complete') {
      // Idempotent — return stored etag
      const storedEtag = (fileRecord as any).etag || `"${uploadId}"`;
      return { location: `/${uploadId}`, etag: storedEtag };
    }

    const uploadedCount = fileRecord.chunks.length;

    if (uploadedCount < declaredPartCount) {
      throw new BadRequestException(
        `Missing parts: uploaded ${uploadedCount}/${declaredPartCount}`,
      );
    }

    // Calculate total size from all chunks
    const totalSize = fileRecord.chunks.reduce(
      (sum: bigint, c) => sum + BigInt(c.size),
      BigInt(0),
    );

    /**
     * AWS multipart ETag format: MD5(concat(part1_md5_raw || part2_md5_raw || ...)) + "-N"
     * Each part's MD5 is stored as a hex string in FileChunk.etag (e.g. `"abc123"`)
     * We strip the quotes, convert hex → raw bytes, concatenate, then MD5 the result.
     */
    const partMd5Buffers = fileRecord.chunks.map((c) => {
      const hexMd5 = ((c as any).etag || '').replace(/"/g, '');
      // If etag is missing (legacy), derive a stable placeholder
      if (!hexMd5 || hexMd5.length !== 32) {
        return crypto.createHash('md5').update(String(c.chunkIndex)).digest();
      }
      return Buffer.from(hexMd5, 'hex');
    });
    const multipartMd5 = crypto
      .createHash('md5')
      .update(Buffer.concat(partMd5Buffers))
      .digest('hex');
    const finalEtag = `"${multipartMd5}-${uploadedCount}"`;

    // Update totalChunks to actual value + mark complete + store ETag + update usedSpace
    await this.prisma.$transaction(async (tx) => {
      await tx.fileRecord.update({
        where: { id: uploadId },
        data: {
          status: 'complete',
          totalChunks: uploadedCount,
          size: totalSize,
          etag: finalEtag,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { usedSpace: { increment: totalSize } },
      });
    });

    this.logger.log(
      `S3 CompleteMultipartUpload done: uploadId=${uploadId}, parts=${uploadedCount}, size=${totalSize}, ETag=${finalEtag}`,
    );

    return { location: `/${uploadId}`, etag: finalEtag };
  }

  // ---------------------------------------------------------------------------
  // AbortMultipartUpload
  // ---------------------------------------------------------------------------

  /**
   * DELETE /s3/:bucket/*key?uploadId=X → AbortMultipartUpload
   *
   * Deletes all uploaded chunks from Telegram + removes the FileRecord.
   */
  async abortMultipartUpload(uploadId: string, userId: string): Promise<void> {
    this.logger.log(`S3 AbortMultipartUpload: uploadId=${uploadId}`);

    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: uploadId, userId },
      include: { chunks: true },
    });

    if (!fileRecord) {
      // Already gone — idempotent, return success
      return;
    }

    if (fileRecord.status === 'complete') {
      throw new BadRequestException(
        'Cannot abort a completed upload. Use DeleteObject instead.',
      );
    }

    // Delete Telegram chunks in parallel
    await Promise.allSettled(
      fileRecord.chunks.map(async (chunk) => {
        if (chunk.telegramMessageId) {
          await this.telegramService.deleteMessage(chunk.telegramMessageId);
        }
      }),
    );

    // Delete the FileRecord (cascades to FileChunk via DB)
    await this.prisma.fileRecord.delete({ where: { id: uploadId } });

    this.logger.log(
      `S3 AbortMultipartUpload done: uploadId=${uploadId}, deleted ${fileRecord.chunks.length} chunks`,
    );
  }

  // ---------------------------------------------------------------------------
  // ListParts
  // ---------------------------------------------------------------------------

  /**
   * GET /s3/:bucket/*key?uploadId=X → ListParts
   *
   * Returns the list of uploaded parts for a given multipart upload.
   */
  async listParts(
    uploadId: string,
    userId: string,
  ): Promise<Array<{ partNumber: number; size: number; etag: string }>> {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: uploadId, userId },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord) throw new NotFoundException(`Upload not found: uploadId=${uploadId}`);

    return fileRecord.chunks.map((c) => ({
      partNumber: c.chunkIndex + 1, // Convert back to 1-based
      size: c.size,
      // Return stored etag if available, otherwise derive a stable placeholder
      etag: (c as any).etag ||
        `"${crypto.createHash('md5').update(String(c.chunkIndex)).digest('hex')}"`,
    }));
  }

  // ---------------------------------------------------------------------------
  // XML Helpers for Multipart responses
  // ---------------------------------------------------------------------------

  buildInitiateMultipartUploadXml(bucket: string, key: string, uploadId: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${this.escapeXml(bucket)}</Bucket>
  <Key>${this.escapeXml(key)}</Key>
  <UploadId>${this.escapeXml(uploadId)}</UploadId>
</InitiateMultipartUploadResult>`;
  }

  buildCompleteMultipartUploadXml(
    bucket: string,
    key: string,
    location: string,
    etag: string,
  ): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>${this.escapeXml(location)}</Location>
  <Bucket>${this.escapeXml(bucket)}</Bucket>
  <Key>${this.escapeXml(key)}</Key>
  <ETag>${this.escapeXml(etag)}</ETag>
</CompleteMultipartUploadResult>`;
  }

  buildListPartsXml(
    bucket: string,
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; size: number; etag: string }>,
  ): string {
    const partsXml = parts
      .map(
        (p) => `
  <Part>
    <PartNumber>${p.partNumber}</PartNumber>
    <Size>${p.size}</Size>
    <ETag>${this.escapeXml(p.etag)}</ETag>
  </Part>`,
      )
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${this.escapeXml(bucket)}</Bucket>
  <Key>${this.escapeXml(key)}</Key>
  <UploadId>${this.escapeXml(uploadId)}</UploadId>
  <IsTruncated>false</IsTruncated>${partsXml}
</ListPartsResult>`;
  }

  /**
   * Parse the CompleteMultipartUpload XML body to count declared parts.
   * XML body format:
   *   <CompleteMultipartUpload>
   *     <Part><PartNumber>1</PartNumber><ETag>"..."</ETag></Part>
   *     ...
   *   </CompleteMultipartUpload>
   */
  parseCompleteMultipartXml(body: string): number {
    const matches = body.match(/<PartNumber>/g);
    return matches ? matches.length : 0;
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
