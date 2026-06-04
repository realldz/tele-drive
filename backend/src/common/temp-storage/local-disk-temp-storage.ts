import { Injectable, NotFoundException } from '@nestjs/common';
import { TempStorage } from './temp-storage.interface';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class LocalDiskTempStorage implements TempStorage {
  private readonly baseDir: string;

  constructor() {
    this.baseDir = process.env.UPLOAD_BUFFER_DIR || './.upload-buffer';
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  async write(key: string, data: Buffer | Readable): Promise<void> {
    const filePath = path.join(this.baseDir, key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    if (Buffer.isBuffer(data)) {
      await fs.promises.writeFile(filePath, data);
    } else {
      const writeStream = fs.createWriteStream(filePath);
      await pipeline(data, writeStream);
    }
  }

  async read(
    key: string,
    options?: { start?: number; end?: number },
  ): Promise<Readable> {
    const filePath = path.join(this.baseDir, key);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(`File not found in temp storage: ${key}`);
    }
    return fs.createReadStream(filePath, options);
  }

  async delete(key: string): Promise<void> {
    const filePath = path.join(this.baseDir, key);
    await fs.promises.unlink(filePath).catch(() => {});
  }

  async exists(key: string): Promise<boolean> {
    const filePath = path.join(this.baseDir, key);
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getUsedBytes(): Promise<bigint> {
    return this.getDirSize(this.baseDir);
  }

  private async getDirSize(dirPath: string): Promise<bigint> {
    let size = 0n;
    try {
      const entries = await fs.promises.readdir(dirPath, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          size += await this.getDirSize(fullPath);
        } else if (entry.isFile()) {
          const stats = await fs.promises.stat(fullPath);
          size += BigInt(stats.size);
        }
      }
    } catch (err) {
      // Ignore errors if directory is deleted or inaccessible
    }
    return size;
  }
}
