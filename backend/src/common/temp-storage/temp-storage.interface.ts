import { Readable } from 'stream';

export const TEMP_STORAGE = Symbol('TEMP_STORAGE');

export interface TempStorage {
  /** Lưu file, key format: "buf/{uuid}.tmp" hoặc "chunk/{fileRecordId}/{chunkIndex}.tmp" */
  write(key: string, data: Buffer | Readable): Promise<void>;
  /** Đọc file theo key, throw nếu không tồn tại */
  read(
    key: string,
    options?: { start?: number; end?: number },
  ): Promise<Readable>;
  /** Xóa file, no-op nếu không tồn tại */
  delete(key: string): Promise<void>;
  /** Kiểm tra file tồn tại */
  exists(key: string): Promise<boolean>;
  /** Tổng dung lượng đang dùng (bytes) */
  getUsedBytes(): Promise<bigint>;
}
