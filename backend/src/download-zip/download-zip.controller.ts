import { Controller, Post, Get, Body, Req, Param } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { getClientIp } from '../common/utils/get-client-ip';
import { DownloadZipService } from './download-zip.service';
import {
  CreateDownloadZipDto,
  CreateSharedDownloadZipDto,
} from './dto/create-download-zip.dto';
import type { Request } from 'express';
import type { AuthenticatedRequest } from '../common/types/request';

@Controller('transfer/download-zip')
export class DownloadZipController {
  constructor(private readonly service: DownloadZipService) {}

  @Post()
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateDownloadZipDto,
  ) {
    const ip = getClientIp(req);
    return this.service.createJob(
      req.user.userId,
      dto.fileIds,
      dto.folderIds,
      ip,
    );
  }

  @Post('shared')
  @Public()
  async createShared(
    @Req() req: Request,
    @Body() dto: CreateSharedDownloadZipDto,
  ) {
    const ip = getClientIp(req);
    return this.service.createSharedJob(
      dto.shareToken,
      dto.fileIds,
      dto.folderIds,
      ip,
    );
  }

  @Get(':id/status')
  @Public()
  async getStatus(@Param('id') id: string) {
    return this.service.getJobStatus(id);
  }
}
