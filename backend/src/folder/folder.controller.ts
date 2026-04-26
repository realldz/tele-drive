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
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { FolderService } from './folder.service';
import { FileService } from '../file/file.service';
import { Public } from '../auth/public.decorator';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { BandwidthInterceptor } from '../common/bandwidth.interceptor';
import { StreamCookieGuard } from '../common/guards/stream-cookie.guard';
import { CreateFolderDto } from './dto/create-folder.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedRequest } from '../common/types/request';
import type { Response, Request } from 'express';
import type { ConflictAction } from '../common/name-conflict.service';

@Controller('folders')
export class FolderController {
  private readonly logger = new Logger(FolderController.name);

  constructor(
    private readonly folderService: FolderService,
    private readonly fileService: FileService,
  ) {}

  @Post()
  async create(
    @Body() body: CreateFolderDto,
    @Query('onConflict') onConflict: 'merge' | 'error' | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const result = await this.folderService.create(
      body.name,
      req.user.userId,
      body.parentId || undefined,
      onConflict as ConflictAction | undefined,
    );
    this.logger.log(
      `Folder created: name="${body.name}", userId=${req.user.userId}, parentId=${body.parentId || 'root'}, conflict=${onConflict || 'error'}`,
    );
    return result;
  }

  @Get('content')
  getContent(
    @Query() pagination: PaginationQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.folderService.getContent(
      req.user.userId,
      pagination.folderId,
      pagination,
    );
  }

  @Get('trash/list')
  listTrash(
    @Query() pagination: PaginationQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.folderService.listTrash(req.user.userId, pagination);
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
  async rename(
    @Param('id') id: string,
    @Body('name') name: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const result = await this.folderService.rename(id, name, req.user.userId);
    this.logger.log(
      `Folder renamed: id=${id}, userId=${req.user.userId}, name="${name}"`,
    );
    return result;
  }

  @Patch(':id/move')
  async move(
    @Param('id') id: string,
    @Body('parentId') parentId: string | null,
    @Body('conflictAction') conflictAction: ConflictAction | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const result = await this.folderService.move(
      id,
      parentId,
      req.user.userId,
      conflictAction,
    );
    this.logger.log(
      `Folder moved: id=${id}, userId=${req.user.userId}, parentId=${parentId || 'root'}, conflictAction=${conflictAction || 'error'}`,
    );
    return result;
  }

  @Delete(':id')
  async softDelete(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const result = await this.folderService.softDelete(id, req.user.userId);
    this.logger.log(`Folder soft-deleted: id=${id}, userId=${req.user.userId}`);
    return result;
  }

  @Patch(':id/restore')
  async restore(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const result = await this.folderService.restore(id, req.user.userId);
    this.logger.log(`Folder restored: id=${id}, userId=${req.user.userId}`);
    return result;
  }

  @Delete(':id/permanent')
  async permanentDelete(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const result = await this.folderService.permanentDelete(
      id,
      req.user.userId,
    );
    this.logger.log(
      `Folder permanently deleted: id=${id}, userId=${req.user.userId}`,
    );
    return result;
  }

  @Post(':id/share')
  async share(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const result = await this.folderService.share(id, req.user.userId);
    this.logger.log(`Folder shared: id=${id}, userId=${req.user.userId}`);
    return result;
  }

  @Post(':id/unshare')
  async unshare(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const result = await this.folderService.unshare(id, req.user.userId);
    this.logger.log(`Folder unshared: id=${id}, userId=${req.user.userId}`);
    return result;
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @Get('share/:token')
  getSharedContent(
    @Param('token') token: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.folderService.getSharedContent(
      token,
      pagination.folderId,
      pagination,
    );
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @Post('share/:token/download-token/:fileId')
  @UseInterceptors(BandwidthInterceptor)
  @SetMetadata('BANDWIDTH_CHECK_ONLY', true)
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
