import { Injectable, Logger, NotFoundException, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { fetchWithRetry } from '../telegram/telegram.service';
import { Transform, TransformCallback, Readable } from 'stream';
import Busboy from 'busboy';
import * as crypto from 'crypto';
import type { Response } from 'express';
import { CryptoService } from '../crypto/crypto.service';

/**
 * Transform stream đếm bytes đi qua — dùng để biết kích thước chunk
 * mà không cần buffer toàn bộ vào memory.
 */
class ByteCounter extends Transform {
  public bytes = 0;
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.bytes += chunk.length;
    this.push(chunk);
    callback();
  }
}

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly cryptoService: CryptoService,
  ) {}

  /**
   * Kiểm tra quota trước khi upload.
   * Throw 400 nếu usedSpace + fileSize > quota.
   */
  private async checkQuota(userId: string, fileSize: number | bigint): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { usedSpace: true, quota: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const size = BigInt(fileSize);
    if (user.usedSpace + size > user.quota) {
      const usedMB = Number(user.usedSpace) / (1024 * 1024);
      const quotaMB = Number(user.quota) / (1024 * 1024);
      this.logger.warn(
        `Quota exceeded for userId ${userId}: usedSpace=${usedMB.toFixed(1)}MB + fileSize=${Number(size) / (1024 * 1024)}MB > quota=${quotaMB.toFixed(1)}MB`,
      );
      throw new HttpException(
        `Storage quota exceeded. Used: ${usedMB.toFixed(1)}MB, Quota: ${quotaMB.toFixed(1)}MB`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Upload file nhỏ (≤ MAX_CHUNK_SIZE)
   * userId lấy từ JWT (req.user.userId)
   * Kiểm tra quota trước upload, cập nhật usedSpace sau upload bằng transaction.
   */
  async uploadFile(file: Express.Multer.File, userId: string, folderId?: string) {
    // Check quota trước khi upload lên Telegram
    await this.checkQuota(userId, file.size);

    const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');

    const dek = this.cryptoService.generateFileKey();
    const iv = this.cryptoService.generateIv();
    const encryptedKey = this.cryptoService.encryptKey(dek);

    // 1) Tạo placeholder FileRecord trước khi upload
    const record = await this.prisma.fileRecord.create({
      data: {
        filename,
        size: file.size,
        mimeType: file.mimetype,
        telegramFileId: null,
        telegramMessageId: null,
        isChunked: false,
        totalChunks: 1,
        status: 'uploading',
        isEncrypted: true,
        encryptionAlgo: 'aes-256-ctr',
        encryptionIv: iv.toString('hex'),
        encryptedKey: encryptedKey,
        folderId: folderId || null,
        userId,
      },
    });

    this.logger.log(`Starting upload to Telegram for file: "${filename}" (${file.size} bytes)`);

    try {
      // 2) Encrypt and Upload lên Telegram
      const cipher = this.cryptoService.createEncryptStream(dek, iv);
      const encryptedBuffer = Buffer.concat([cipher.update(file.buffer), cipher.final()]);
      // Use record.id as the Telegram filename to avoid leaking the real filename
      const { fileId: telegramFileId, messageId: telegramMessageId } = await this.telegram.uploadFile(encryptedBuffer, record.id);

      // 3) Thành công -> Update trạng thái và cộng dung lượng
      const updated = await this.prisma.$transaction(async (tx) => {
        const fileRecord = await tx.fileRecord.update({
          where: { id: record.id },
          data: {
            telegramFileId,
            telegramMessageId,
            status: 'complete',
          },
        });

        await tx.user.update({
          where: { id: userId },
          data: { usedSpace: { increment: file.size } },
        });

        return fileRecord;
      });

      this.logger.log(`File uploaded: "${filename}" (${file.size} bytes, userId: ${userId}, recordId: ${record.id})`);
      return updated;
    } catch (err: any) {
      // Nếu lỗi upload, xoá placeholder record
      await this.prisma.fileRecord.delete({ where: { id: record.id } });
      this.logger.error(`Failed to upload file to Telegram: ${filename}`, err);
      throw err;
    }
  }

  /**
   * Khởi tạo upload chunked — tạo FileRecord placeholder với status "uploading"
   * userId lấy từ JWT (req.user.userId)
   * Kiểm tra quota trước khi init.
   */
  async initChunkedUpload(
    filename: string,
    size: number,
    mimeType: string,
    totalChunks: number,
    userId: string,
    folderId?: string,
  ) {
    // Check quota trước khi bắt đầu upload chunks
    await this.checkQuota(userId, size);
    const dek = this.cryptoService.generateFileKey();
    const iv = this.cryptoService.generateIv();
    const encryptedKey = this.cryptoService.encryptKey(dek);

    const record = await this.prisma.fileRecord.create({
      data: {
        filename,
        size,
        mimeType,
        telegramFileId: null,
        telegramMessageId: null,
        isChunked: true,
        totalChunks,
        status: 'uploading',
        isEncrypted: true,
        encryptionAlgo: 'aes-256-ctr',
        encryptionIv: iv.toString('hex'),
        encryptedKey: encryptedKey,
        folderId: folderId || null,
        userId,
      },
    });

    this.logger.log(`Chunked upload initialized: "${filename}" (${size} bytes, ${totalChunks} chunks, userId: ${userId}, recordId: ${record.id})`);
    return record;
  }

  /**
   * Upload chunk bằng stream pipe-through:
   * 
   *   Client ──stream──▶ busboy ──pipe──▶ ByteCounter ──pipe──▶ Telegram
   *                (tất cả diễn ra đồng thời, không buffer toàn bộ chunk)
   */
  async uploadChunkStream(fileId: string, chunkIndex: number, userId: string, req: any): Promise<any> {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File record not found');
    if (fileRecord.status !== 'uploading') throw new BadRequestException('File upload already completed or aborted');
    if (chunkIndex < 0 || chunkIndex >= fileRecord.totalChunks) {
      throw new BadRequestException(`Invalid chunk index: ${chunkIndex}. Expected 0-${fileRecord.totalChunks - 1}`);
    }

    // Idempotent: nếu chunk đã upload rồi, bỏ qua
    const existing = await this.prisma.fileChunk.findUnique({
      where: { fileId_chunkIndex: { fileId, chunkIndex } },
    });
    if (existing) {
      req.resume(); // Drain request body
      this.logger.debug(`Chunk ${chunkIndex}/${fileRecord.totalChunks} already uploaded for file ${fileId}, skipping`);
      return existing;
    }

    // Use record id as chunk filename to avoid leaking the real filename on Telegram
    const chunkFilename = `${fileRecord.id}.part${String(chunkIndex).padStart(3, '0')}`;

    // Get DEK and generate new IV for this chunk
    let dek: Buffer | null = null;
    let chunkIv: Buffer | null = null;
    if (fileRecord.isEncrypted && fileRecord.encryptedKey) {
      dek = this.cryptoService.decryptKey(fileRecord.encryptedKey);
      chunkIv = this.cryptoService.generateIv();
    }

    return new Promise<any>((resolve, reject) => {
      const bb = Busboy({ headers: req.headers });
      let fileProcessed = false;

      bb.on('file', (_name: string, stream: Readable) => {
        if (fileProcessed) {
          stream.resume();
          return;
        }
        fileProcessed = true;

        // Collect the stream into a buffer so we can retry on ECONNRESET.
        // Chunks are typically ~20MB — safe to buffer in memory.
        const chunks: Buffer[] = [];
        let rawBytes = 0;

        let dataStream: Readable | Transform = stream;
        if (dek && chunkIv) {
          const cipherStream = this.cryptoService.createEncryptStream(dek, chunkIv);
          dataStream = stream.pipe(cipherStream);
        }

        dataStream.on('data', (buf: Buffer) => {
          chunks.push(buf);
          rawBytes += buf.length;
        });

        dataStream.on('error', (err: Error) => reject(err));

        dataStream.on('end', () => {
          const buffer = Buffer.concat(chunks);

          this.logger.log(`Starting chunk upload to Telegram: ${chunkIndex + 1}/${fileRecord.totalChunks} for file "${fileRecord.filename}" (${fileRecord.id}), ${rawBytes} bytes`);

          // uploadFile() has built-in retry with exponential backoff
          this.telegram.uploadFile(buffer, chunkFilename)
            .then(async ({ fileId: telegramFileId, messageId: telegramMessageId }) => {
              const chunk = await this.prisma.fileChunk.create({
                data: {
                  fileId,
                  chunkIndex,
                  size: rawBytes,
                  telegramFileId,
                  telegramMessageId,
                  ...(chunkIv && { encryptionIv: chunkIv.toString('hex') }),
                },
              });
              this.logger.debug(`Chunk uploaded: ${chunkIndex + 1}/${fileRecord.totalChunks} for file ${fileId} (${rawBytes} bytes)`);
              resolve(chunk);
            })
            .catch((err) => {
              this.logger.error(`Chunk upload failed: ${chunkIndex}/${fileRecord.totalChunks} for file ${fileId}: ${err.message}`);
              reject(err);
            });
        });
      });

      bb.on('error', (err: Error) => reject(err));

      bb.on('close', () => {
        if (!fileProcessed) {
          reject(new BadRequestException('No file field received in the request'));
        }
      });

      req.pipe(bb);
    });
  }

  /**
   * Huỷ upload chunked
   */
  async abortUpload(fileId: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, userId, deletedAt: null },
      include: { chunks: true },
    });
    if (!fileRecord) throw new NotFoundException('File record not found');

    if (fileRecord.status === 'complete') {
      throw new BadRequestException('Cannot abort a completed upload. Use DELETE instead.');
    }

    await this.prisma.fileRecord.update({
      where: { id: fileId },
      data: { status: 'aborted' },
    });

    const deletePromises = fileRecord.chunks.map(async (chunk) => {
      if (chunk.telegramMessageId) {
        await this.telegram.deleteMessage(chunk.telegramMessageId);
      }
    });
    await Promise.allSettled(deletePromises);

    await this.prisma.fileRecord.delete({ where: { id: fileId } });

    this.logger.warn(`Upload aborted: "${fileRecord.filename}" (fileId: ${fileId}, cleaned up ${fileRecord.chunks.length} chunks)`);
    return { success: true, deletedChunks: fileRecord.chunks.length };
  }

  /**
   * Hoàn tất upload chunked — kiểm tra đủ chunks rồi đánh dấu complete.
   * Cập nhật usedSpace trong transaction.
   */
  async completeChunkedUpload(fileId: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, userId, deletedAt: null },
      include: { chunks: true },
    });
    if (!fileRecord) throw new NotFoundException('File record not found');
    if (fileRecord.status === 'complete') return fileRecord;

    const uploadedChunks = fileRecord.chunks.length;
    if (uploadedChunks < fileRecord.totalChunks) {
      throw new BadRequestException(
        `Missing chunks: uploaded ${uploadedChunks}/${fileRecord.totalChunks}`,
      );
    }

    // Transaction: đánh dấu complete + cộng usedSpace
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.fileRecord.update({
        where: { id: fileId },
        data: { status: 'complete' },
      });

      await tx.user.update({
        where: { id: userId },
        data: { usedSpace: { increment: fileRecord.size } },
      });

      return updated;
    });

    this.logger.log(`Chunked upload completed: "${fileRecord.filename}" (fileId: ${fileId}, ${fileRecord.totalChunks} chunks, ${fileRecord.size} bytes)`);
    return result;
  }

  /**
   * Truy vấn metadata file cụ thể
   */
  async getFileInfo(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
      select: {
        id: true,
        filename: true,
        size: true,
        mimeType: true,
        createdAt: true,
      },
    });
    if (!fileRecord) throw new NotFoundException('File not found');
    return fileRecord;
  }

  /**
   * Lấy thông tin download — hỗ trợ cả file thường và file chunked
   * Scope theo userId để đảm bảo user chỉ download file của mình
   */
  async getDownloadInfo(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord) throw new NotFoundException('File not found');
    if (fileRecord.status !== 'complete') throw new BadRequestException('File upload not completed yet');

    return this.resolveDownloadUrls(fileRecord);
  }

  /**
   * Lấy thông tin download bằng share token (dùng cho public)
   */
  async getDownloadInfoByToken(token: string) {
    const fileRecord = await this.prisma.fileRecord.findUnique({
      where: { shareToken: token },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord || fileRecord.deletedAt) throw new NotFoundException('Shared file not found');
    if (fileRecord.status !== 'complete') throw new BadRequestException('File upload not completed yet');

    return this.resolveDownloadUrls(fileRecord);
  }

  /**
   * Helper phân giải FileRecord thành URLs download
   */
  async resolveDownloadUrls(fileRecord: any) {
    let dek: Buffer | null = null;
    if (fileRecord.isEncrypted && fileRecord.encryptedKey) {
      dek = this.cryptoService.decryptKey(fileRecord.encryptedKey);
    }

    if (!fileRecord.isChunked && fileRecord.telegramFileId) {
      const url = await this.telegram.getFileLink(fileRecord.telegramFileId);
      return {
        filename: fileRecord.filename,
        size: fileRecord.size,
        urls: [url],
        isEncrypted: fileRecord.isEncrypted,
        dek,
        iv: fileRecord.encryptionIv ? Buffer.from(fileRecord.encryptionIv, 'hex') : null,
        mimeType: fileRecord.mimeType,
      };
    }

    const chunks = fileRecord.chunks.map((chunk: any) => ({
      telegramFileId: chunk.telegramFileId,
      iv: chunk.encryptionIv ? Buffer.from(chunk.encryptionIv, 'hex') : null,
      size: Number(chunk.size),
    }));

    return {
      filename: fileRecord.filename,
      size: fileRecord.size,
      isChunked: true,
      chunks,
      isEncrypted: fileRecord.isEncrypted,
      dek,
      mimeType: fileRecord.mimeType,
    };
  }

  /**
   * Helper process download file (dùng Streams)
   */
  async processDownload(downloadInfo: any, res: Response) {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadInfo.filename)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', downloadInfo.size.toString());

    if (!downloadInfo.isChunked) {
      const fetchRes = await fetchWithRetry(downloadInfo.urls[0]);
      if (!fetchRes.ok || !fetchRes.body) {
        this.logger.error(`Failed to fetch file from Telegram: "${downloadInfo.filename}"`);
        res.status(500).send('Trích xuất file từ Telegram thất bại');
        return;
      }
      
      let stream: Readable | Transform = Readable.fromWeb(fetchRes.body as any);
      if (downloadInfo.isEncrypted && downloadInfo.dek && downloadInfo.iv) {
        const decipher = this.cryptoService.createDecryptStream(downloadInfo.dek, downloadInfo.iv);
        stream = stream.pipe(decipher);
      }
      stream.pipe(res);
    } else {
      try {
        for (const chunk of downloadInfo.chunks) {
          const chunkUrl = await this.telegram.getFileLink(chunk.telegramFileId);
          const fetchRes = await fetchWithRetry(chunkUrl);
          if (!fetchRes.ok || !fetchRes.body) {
            throw new Error('Failed to fetch chunk from Telegram');
          }

          await new Promise<void>((resolve, reject) => {
            let stream: Readable | Transform = Readable.fromWeb(fetchRes.body as any);
            if (downloadInfo.isEncrypted && downloadInfo.dek && chunk.iv) {
              const decipher = this.cryptoService.createDecryptStream(downloadInfo.dek, chunk.iv);
              stream = stream.pipe(decipher);
            }

            stream.on('end', resolve);
            stream.on('error', reject);
            stream.pipe(res, { end: false });
          });
        }
        res.end();
      } catch (error) {
        this.logger.error(`Chunked download failed: "${downloadInfo.filename}"`, error instanceof Error ? error.stack : String(error));
        if (!res.headersSent) {
          res.status(500).send('Lỗi khi ghép file từ Telegram');
        } else {
          res.end();
        }
      }
    }
  }

  /**
   * Helper process streaming media (dùng Range Requests)
   */
  async processStream(downloadInfo: any, rangeHeader: string | undefined, res: Response) {
    const fileSize = Number(downloadInfo.size);
    let start = 0;
    let end = fileSize - 1;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        start = parseInt(match[1], 10);
        if (match[2]) {
          end = parseInt(match[2], 10);
        }
      }
    }

    if (start >= fileSize) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
      return res.end();
    }
    
    end = Math.min(end, fileSize - 1);
    const contentLength = end - start + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', contentLength.toString());
    res.setHeader('Content-Type', downloadInfo.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');

    if (!downloadInfo.isChunked) {
      const fetchRes = await fetchWithRetry(downloadInfo.urls[0], {
        headers: { Range: `bytes=${start}-${end}` }
      });
      if (!fetchRes.ok || !fetchRes.body) {
        this.logger.error(`Failed to fetch stream from Telegram: "${downloadInfo.filename}"`);
        return res.status(500).end();
      }
      
      let stream: Readable | Transform = Readable.fromWeb(fetchRes.body as any);
      if (downloadInfo.isEncrypted && downloadInfo.dek && downloadInfo.iv) {
        stream = stream.pipe(this.cryptoService.createOffsetDecryptStream(downloadInfo.dek, downloadInfo.iv, start));
      }
      stream.pipe(res);
    } else {
      let currentOffset = 0;
      const chunksToFetch = [];
      
      for (const chunk of downloadInfo.chunks) {
        // chunk doesn't explicitly store its own total size individually in some places but wait, chunk.size is present!
        // wait, we didn't add chunk.size to downloadInfo.chunks in resolveDownloadUrls!
        // Let's rely on chunk.size. We MUST add chunk.size to resolveDownloadUrls!
        const chunkStart = currentOffset;
        const chunkEnd = currentOffset + chunk.size - 1;
        
        if (start <= chunkEnd && end >= chunkStart) {
          const fetchStart = Math.max(start, chunkStart) - chunkStart;
          const fetchEnd = Math.min(end, chunkEnd) - chunkStart;
          
          chunksToFetch.push({
            ...chunk,
            fetchStart,
            fetchEnd,
            byteOffsetInChunk: fetchStart
          });
        }
        currentOffset += chunk.size;
      }

      try {
        for (const chunkReq of chunksToFetch) {
          const chunkUrl = await this.telegram.getFileLink(chunkReq.telegramFileId);
          const fetchRes = await fetchWithRetry(chunkUrl, {
            headers: { Range: `bytes=${chunkReq.fetchStart}-${chunkReq.fetchEnd}` }
          });
          if (!fetchRes.ok || !fetchRes.body) throw new Error('Fetch chunk error');

          await new Promise<void>((resolve, reject) => {
            let stream: Readable | Transform = Readable.fromWeb(fetchRes.body as any);
            if (downloadInfo.isEncrypted && downloadInfo.dek && chunkReq.iv) {
              stream = stream.pipe(this.cryptoService.createOffsetDecryptStream(downloadInfo.dek, chunkReq.iv, chunkReq.byteOffsetInChunk));
            }
            stream.on('end', resolve);
            stream.on('error', reject);
            stream.pipe(res, { end: false });
          });
        }
        res.end();
      } catch (err) {
        this.logger.error('Stream error', err);
        if (!res.headersSent) res.status(500).end();
        else res.end();
      }
    }
  }

  /**
   * Lấy thông tin file shared
   */
  async getSharedFileInfo(token: string) {
    const fileRecord = await this.prisma.fileRecord.findUnique({
      where: { shareToken: token },
      select: {
        id: true,
        filename: true,
        size: true,
        mimeType: true,
        createdAt: true,
        user: { select: { username: true } },
      },
    });
    if (!fileRecord) throw new NotFoundException('Shared file not found');

    return fileRecord;
  }

  /**
   * Đổi tên file
   */
  async rename(id: string, newName: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { filename: newName },
    });

    this.logger.log(`File renamed: "${fileRecord.filename}" to "${newName}" (fileId: ${id})`);
    return updated;
  }

  /**
   * Di chuyển file
   */
  async move(id: string, newFolderId: string | null, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    if (newFolderId) {
      const folder = await this.prisma.folder.findFirst({
        where: { id: newFolderId, userId, deletedAt: null },
      });
      if (!folder) throw new NotFoundException('Destination folder not found');
    }

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { folderId: newFolderId },
    });

    this.logger.log(`File moved: "${fileRecord.filename}" (fileId: ${id}) to folder: ${newFolderId || 'root'}`);
    return updated;
  }

  /**
   * Chia sẻ file (tạo shareLink)
   */
  async share(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    const shareToken = fileRecord.shareToken || crypto.randomBytes(16).toString('hex');

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { 
        visibility: 'PUBLIC_LINK',
        shareToken,
      },
    });

    this.logger.log(`File shared: "${fileRecord.filename}" (fileId: ${id}, token: ${shareToken})`);
    return updated;
  }

  /**
   * Huỷ chia sẻ file
   */
  async unshare(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { 
        visibility: 'PRIVATE',
        shareToken: null,
      },
    });

    this.logger.log(`File unshared: "${fileRecord.filename}" (fileId: ${id})`);
    return updated;
  }

  /**
   * Xoá vĩnh viễn file — xoá trên Telegram + DB + hoàn trả usedSpace.
   * Scope theo userId nếu có.
   */
  async delete(id: string, userId?: string) {
    const where: any = { id };
    if (userId) {
      where.userId = userId;
      where.deletedAt = null;
    }

    const fileRecord = await this.prisma.fileRecord.findFirst({
      where,
      include: { chunks: true },
    });
    if (!fileRecord) return;

    if (fileRecord.telegramMessageId) {
      await this.telegram.deleteMessage(fileRecord.telegramMessageId);
    }

    for (const chunk of fileRecord.chunks) {
      if (chunk.telegramMessageId) {
        await this.telegram.deleteMessage(chunk.telegramMessageId);
      }
    }

    // Transaction: xoá FileRecord + trừ usedSpace (chỉ nếu file đã complete)
    await this.prisma.$transaction(async (tx) => {
      await tx.fileRecord.delete({ where: { id } });

      if (fileRecord.status === 'complete') {
        await tx.user.update({
          where: { id: fileRecord.userId },
          data: { usedSpace: { decrement: fileRecord.size } },
        });
      }
    });

    this.logger.log(`File deleted: "${fileRecord.filename}" (fileId: ${id}, chunks: ${fileRecord.chunks.length}, freed: ${fileRecord.size} bytes)`);
  }

  /**
   * Soft delete — chuyển file vào thùng rác (giữ nguyên usedSpace).
   */
  async softDelete(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    this.logger.log(`File soft-deleted: "${fileRecord.filename}" (fileId: ${id}, userId: ${userId})`);
    return updated;
  }

  /**
   * Khôi phục file từ thùng rác.
   */
  async restore(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: { not: null } },
    });
    if (!fileRecord) throw new NotFoundException('File not found in trash');

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { deletedAt: null },
    });

    this.logger.log(`File restored: "${fileRecord.filename}" (fileId: ${id}, userId: ${userId})`);
    return updated;
  }

  /**
   * Xoá vĩnh viễn file từ thùng rác — xoá trên Telegram + DB + hoàn trả usedSpace.
   */
  async permanentDelete(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: { not: null } },
      include: { chunks: true },
    });
    if (!fileRecord) throw new NotFoundException('File not found in trash');

    // Xoá trên Telegram
    if (fileRecord.telegramMessageId) {
      await this.telegram.deleteMessage(fileRecord.telegramMessageId);
    }
    for (const chunk of fileRecord.chunks) {
      if (chunk.telegramMessageId) {
        await this.telegram.deleteMessage(chunk.telegramMessageId);
      }
    }

    // Transaction: xoá DB + trừ usedSpace
    await this.prisma.$transaction(async (tx) => {
      await tx.fileRecord.delete({ where: { id } });

      if (fileRecord.status === 'complete') {
        await tx.user.update({
          where: { id: fileRecord.userId },
          data: { usedSpace: { decrement: fileRecord.size } },
        });
      }
    });

    this.logger.log(`File permanently deleted: "${fileRecord.filename}" (fileId: ${id}, freed: ${fileRecord.size} bytes)`);
  }

  /**
   * Danh sách file trong thùng rác của user.
   */
  async listTrash(userId: string) {
    return this.prisma.fileRecord.findMany({
      where: { userId, deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
    });
  }

  /**
   * Lấy danh sách chunks đã upload cho file (dùng cho resume upload)
   */
  async getUploadedChunks(fileId: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File record not found');

    const chunks = await this.prisma.fileChunk.findMany({
      where: { fileId },
      select: { chunkIndex: true },
      orderBy: { chunkIndex: 'asc' },
    });

    return {
      fileId,
      totalChunks: fileRecord.totalChunks,
      uploadedIndexes: chunks.map((c: { chunkIndex: number }) => c.chunkIndex),
      status: fileRecord.status,
    };
  }
}
