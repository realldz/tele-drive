import { Controller, Get, Post, Delete, Patch, Body, Param, Query, Req, Res, UseInterceptors, UnauthorizedException } from '@nestjs/common';
import { FolderService } from './folder.service';
import { FileService } from '../file/file.service';
import { CryptoService } from '../crypto/crypto.service';
import { Public } from '../auth/public.decorator';
import { BandwidthInterceptor } from '../common/bandwidth.interceptor';
import { CreateFolderDto } from './dto/create-folder.dto';
import type { AuthenticatedRequest } from '../common/types/request';
import type { Response, Request } from 'express';

@Controller('folders')
export class FolderController {
  constructor(
    private readonly folderService: FolderService,
    private readonly fileService: FileService,
    private readonly cryptoService: CryptoService,
  ) {}

  @Post()
  create(@Body() body: CreateFolderDto, @Req() req: AuthenticatedRequest) {
    return this.folderService.create(body.name, req.user.userId, body.parentId || undefined);
  }

  @Get('content')
  getContent(@Query('folderId') folderId: string | undefined, @Req() req: AuthenticatedRequest) {
    return this.folderService.getContent(req.user.userId, folderId);
  }

  @Get('trash/list')
  listTrash(@Req() req: AuthenticatedRequest) {
    return this.folderService.listTrash(req.user.userId);
  }

  @Get()
  findAll(@Query('parentId') parentId: string | undefined, @Req() req: AuthenticatedRequest) {
    return this.folderService.findAll(req.user.userId, parentId);
  }

  @Get(':id/breadcrumbs')
  getBreadcrumbs(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.folderService.getBreadcrumbs(id, req.user.userId);
  }

  @Patch(':id/rename')
  rename(@Param('id') id: string, @Body('name') name: string, @Req() req: AuthenticatedRequest) {
    return this.folderService.rename(id, name, req.user.userId);
  }

  @Patch(':id/move')
  move(@Param('id') id: string, @Body('parentId') parentId: string | null, @Req() req: AuthenticatedRequest) {
    return this.folderService.move(id, parentId, req.user.userId);
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
  @Get('share/:token')
  getSharedContent(@Param('token') token: string, @Query('folderId') folderId?: string) {
    return this.folderService.getSharedContent(token, folderId);
  }

  @Public()
  @Post('share/:token/download-token/:fileId')
  generateShareFolderDownloadToken(@Param('token') token: string, @Param('fileId') fileId: string) {
    return this.folderService.generateShareFolderDownloadToken(token, fileId);
  }

  @Public()
  @UseInterceptors(BandwidthInterceptor)
  @Get('share/:token/download/:fileId')
  async downloadSharedFile(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    const downloadInfo = await this.folderService.getSharedFileDownloadInfo(token, fileId);
    return this.fileService.processDownload(downloadInfo, res, req.headers.range);
  }

  @Public()
  @UseInterceptors(BandwidthInterceptor)
  @Get('share/:token/stream/:fileId')
  async streamSharedFolderFile(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    this.verifyStreamCookie(req);
    const downloadInfo = await this.folderService.getSharedFileDownloadInfo(token, fileId);
    return this.fileService.processStream(downloadInfo, req.headers.range as string | undefined, res);
  }

  private verifyStreamCookie(req: Request): { sub: string; exp: number } {
    const streamToken = req.cookies?.stream_token;
    if (!streamToken) throw new UnauthorizedException('Stream cookie required');
    const payload = this.cryptoService.verifyStreamCookieToken(streamToken);
    if (!payload) throw new UnauthorizedException('Invalid or expired stream cookie');
    return payload;
  }
}
