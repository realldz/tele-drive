import { Controller, Get, Put, Param, Body, UseGuards } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { AdminGuard } from '../auth/admin.guard';

@Controller('settings')
@UseGuards(AdminGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  /**
   * GET /settings — Lấy tất cả cấu hình hệ thống (Admin only)
   */
  @Get()
  findAll() {
    return this.settingsService.findAll();
  }

  /**
   * GET /settings/:key — Lấy 1 cấu hình (Admin only)
   */
  @Get(':key')
  findByKey(@Param('key') key: string) {
    return this.settingsService.findByKey(key);
  }

  /**
   * PUT /settings/:key — Cập nhật 1 cấu hình (Admin only)
   * Body: { value: string }
   */
  @Put(':key')
  update(@Param('key') key: string, @Body('value') value: string) {
    return this.settingsService.upsert(key, value);
  }
}
