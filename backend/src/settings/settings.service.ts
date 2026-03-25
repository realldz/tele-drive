import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Giá trị mặc định seed khi hệ thống khởi tạo lần đầu */
const DEFAULT_SETTINGS: Record<string, string> = {
  DEFAULT_USER_QUOTA: '15000000000',            // 15 GB
  DEFAULT_GUEST_BANDWIDTH: '1000000000',         // 1 GB/day
  DEFAULT_FILE_DOWNLOAD_LIMIT: '0',              // 0 = không giới hạn
  DEFAULT_DAILY_BANDWIDTH_LIMIT: '0',            // 0 = không giới hạn
  ENABLE_MULTI_THREAD_DOWNLOAD: 'true',          // Cho phép download managers (IDM) dùng multi-thread
  MAX_CONCURRENT_CHUNKS: '3',                      // Số chunk tối đa 1 client upload đồng thời
};

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Seed giá trị mặc định khi module khởi tạo (chỉ tạo nếu chưa tồn tại)
   */
  async onModuleInit() {
    let seeded = 0;
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      const existing = await this.prisma.systemSetting.findUnique({ where: { key } });
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
    return result;
  }
}
