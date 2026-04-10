import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import { FolderService } from './folder.service';
import { FileService } from '../file/file.service';
import { Public } from '../auth/public.decorator';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { BandwidthInterceptor } from '../common/bandwidth.interceptor';
import { StreamCookieGuard } from '../common/guards/stream-cookie.guard';
import { CreateFolderDto } from './dto/create-folder.dto';
import type { AuthenticatedRequest } from '../common/types/request';
import type { Response, Request } from 'express';
import type { ConflictAction } from '../common/name-conflict.service';

@Controller('folders')
export class FolderController {
  constructor(
    private readonly folderService: FolderService,
    private readonly fileService: FileService,
  ) {}

  @Post()
  create(
    @Body() body: CreateFolderDto,
    @Query('onConflict') onConflict: 'merge' | 'error' | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.folderService.create(
      body.name,
      req.user.userId,
      body.parentId || undefined,
      onConflict as ConflictAction | undefined,
    );
  }

  @Get('content')
  getContent(
    @Query('folderId') folderId: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.folderService.getContent(req.user.userId, folderId);
  }

  @Get('trash/list')
  listTrash(@Req() req: AuthenticatedRequest) {
    return this.folderService.listTrash(req.user.userId);
  }

  @Get()
  findAll(
    @Query('parentId') parentId: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.folderService.findAll(req.user.userId, parentId);
  }

  @Get(':id/breadcrumbs')
  getBreadcrumbs(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.folderService.getBreadcrumbs(id, req.user.userId);
  }

  @Patch(':id/rename')
  rename(
    @Param('id') id: string,
    @Body('name') name: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.folderService.rename(id, name, req.user.userId);
  }

  @Patch(':id/move')
  move(
    @Param('id') id: string,
    @Body('parentId') parentId: string | null,
    @Body('conflictAction') conflictAction: ConflictAction | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.folderService.move(id, parentId, req.user.userId, conflictAction);
  }

  @Delete(':id')
  softDelete(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.folderService.softDelete(id, req.user.userId);
  }

  @Patch(':id/restore')
  restore(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.folderService.restore(id, req.user.userId);
  }

  @Delete(':id/permanent')
  permanentDelete(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.folderService.permanentDelete(id, req.user.userId);
  }

  @Post(':id/share')
  share(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.folderService.share(id, req.user.userId);
  }

  @Post(':id/unshare')
  unshare(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.folderService.unshare(id, req.user.userId);
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @Get('share/:token')
  getSharedContent(
    @Param('token') token: string,
    @Query('folderId') folderId?: string,
  ) {
    return this.folderService.getSharedContent(token, folderId);
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @Post('share/:token/download-token/:fileId')
  generateShareFolderDownloadToken(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
  ) {
    return this.folderService.generateShareFolderDownloadToken(token, fileId);
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @UseInterceptors(BandwidthInterceptor)
  @Get('share/:token/download/:fileId')
  async downloadSharedFile(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const downloadInfo = await this.folderService.getSharedFileDownloadInfo(
      token,
      fileId,
    );
    return this.fileService.processDownload(
      downloadInfo,
      res,
      req.headers.range,
    );
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @UseGuards(StreamCookieGuard)
  @UseInterceptors(BandwidthInterceptor)
  @Get('share/:token/stream/:fileId')
  async streamSharedFolderFile(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const downloadInfo = await this.folderService.getSharedFileDownloadInfo(
      token,
      fileId,
    );
    return this.fileService.processStream(downloadInfo, req.headers.range, res);
  }
}
