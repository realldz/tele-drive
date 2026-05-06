import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Giá trị mặc định seed khi hệ thống khởi tạo lần đầu */
const DEFAULT_SETTINGS: Record<string, string> = {
  DEFAULT_USER_QUOTA: '15000000000', // 15 GB
  DEFAULT_GUEST_BANDWIDTH: '1000000000', // 1 GB/day
  DEFAULT_FILE_DOWNLOAD_LIMIT: '0', // 0 = không giới hạn
  DEFAULT_DAILY_BANDWIDTH_LIMIT: '0', // 0 = không giới hạn
  ENABLE_MULTI_THREAD_DOWNLOAD: 'true', // Cho phép download managers (IDM) dùng multi-thread
  MAX_CONCURRENT_CHUNKS: '3', // Số chunk tối đa 1 client upload đồng thời
  DOWNLOAD_URL_TTL_SECONDS: '300', // 5 phút — thời hạn signed download URL
  STREAM_COOKIE_TTL_SECONDS: '3600', // 1 giờ — thời hạn stream cookie
  S3_PUBLIC_ACCESS_ENABLED: 'true', // Cho phép public S3 bucket access toàn cục
};

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);

  /** In-memory cache for getCachedSetting() */
  private readonly settingsCache = new Map<
    string,
    { value: unknown; expiry: number }
  >();
  private readonly DEFAULT_CACHE_TTL_MS = 30_000; // 30 seconds

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Seed giá trị mặc định khi module khởi tạo (chỉ tạo nếu chưa tồn tại)
   */
  async onModuleInit() {
    let seeded = 0;
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      const existing = await this.prisma.systemSetting.findUnique({
        where: { key },
      });
      if (!existing) {
        await this.prisma.systemSetting.create({ data: { key, value } });
        seeded++;
      }
    }
    if (seeded > 0) {
      this.logger.log(`Seeded ${seeded} default system settings`);
    }
  }

  /**
   * GET /settings — Lấy tất cả cấu hình hệ thống
   */
  async findAll() {
    return this.prisma.systemSetting.findMany({
      orderBy: { key: 'asc' },
    });
  }

  /**
   * GET /settings/:key — Lấy 1 cấu hình
   */
  async findByKey(key: string) {
    return this.prisma.systemSetting.findUnique({ where: { key } });
  }

  /**
   * PUT /settings/:key — Cập nhật 1 cấu hình (upsert)
   */
  async upsert(key: string, value: string) {
    const result = await this.prisma.systemSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });

    this.logger.log(`Setting updated: "${key}" = "${value}"`);

    // Invalidate cache on update
    this.settingsCache.delete(key);

    return result;
  }

  /**
   * Generic cached system setting accessor.
   *
   * Reads once from DB, caches for `cacheTtlMs` (default 30s).
   * Use `parser` to convert the raw string value to the desired type.
   *
   * Example:
   *   const ttl = await settingsService.getCachedSetting('DOWNLOAD_URL_TTL_SECONDS', 300, parseInt);
   *   const enabled = await settingsService.getCachedSetting('FEATURE_FLAG', true, v => v !== 'false');
   */
  async getCachedSetting<T>(
    key: string,
    defaultValue: T,
    parser?: (value: string) => T,
    cacheTtlMs?: number,
  ): Promise<T> {
    const cached = this.settingsCache.get(key);
    if (cached && cached.expiry > Date.now()) {
      return cached.value as T;
    }

    const setting = await this.prisma.systemSetting.findUnique({
      where: { key },
    });
    let value: T;
    if (setting) {
      value = parser ? parser(setting.value) : (setting.value as unknown as T);
      // If parser returns NaN or null/undefined, fall back to default
      if (
        value === null ||
        value === undefined ||
        (typeof value === 'number' && isNaN(value))
      ) {
        value = defaultValue;
      }
    } else {
      value = defaultValue;
    }

    this.settingsCache.set(key, {
      value,
      expiry: Date.now() + (cacheTtlMs ?? this.DEFAULT_CACHE_TTL_MS),
    });

    return value;
  }

  /** Invalidate a specific cached setting (e.g., after admin update). */
  invalidateCache(key: string): void {
    this.settingsCache.delete(key);
  }
}
