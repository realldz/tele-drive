import { Controller, Logger, Get, Post, Patch, Delete, Param, Req, Res, UseInterceptors, UseGuards, ParseIntPipe, Body, Head, HttpCode, HttpStatus, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { FileService } from './file.service';
import { MAX_CHUNK_SIZE } from '../config/upload.config';
import { BandwidthInterceptor } from '../common/bandwidth.interceptor';
import { Public } from '../auth/public.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { InitUploadDto } from './dto/init-upload.dto';
import type { AuthenticatedRequest } from '../common/types/request';
import type { Response, Request } from 'express';

const multerOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_CHUNK_SIZE + 1024 * 1024 },
};

@Controller('files')
export class FileController {
  private readonly logger = new Logger(FileController.name);

  constructor(private readonly fileService: FileService) {}

  @Public()
  @Get('config')
  async getConfig() {
    return {
      maxChunkSize: MAX_CHUNK_SIZE,
      maxConcurrentChunks: await this.fileService.getMaxConcurrentChunks(),
    };
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', multerOptions))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('folderId') folderId: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.fileService.uploadFile(file, req.user.userId, folderId);
  }

  @Post('upload/init')
  async initChunkedUpload(
    @Body() body: InitUploadDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.fileService.initChunkedUpload(
      body.filename,
      body.size,
      body.mimeType,
      body.totalChunks,
      req.user.userId,
      body.folderId,
    );
  }

  @Post('upload/:fileId/chunk/:index')
  async uploadChunk(
    @Param('fileId') fileId: string,
    @Param('index', ParseIntPipe) index: number,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.fileService.uploadChunkStream(fileId, index, req.user.userId, req);
  }

  @Post('upload/:fileId/complete')
  async completeUpload(@Param('fileId') fileId: string, @Req() req: AuthenticatedRequest) {
    return this.fileService.completeChunkedUpload(fileId, req.user.userId);
  }

  @Post('upload/:fileId/abort')
  async abortUpload(@Param('fileId') fileId: string, @Req() req: AuthenticatedRequest) {
    return this.fileService.abortUpload(fileId, req.user.userId);
  }

  @Get('upload/:fileId/status')
  async getUploadStatus(@Param('fileId') fileId: string, @Req() req: AuthenticatedRequest) {
    return this.fileService.getUploadedChunks(fileId, req.user.userId);
  }

  @Get(':id/info')
  getFileInfo(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.fileService.getFileInfo(id, req.user.userId);
  }

  @Get(':id/download')
  @UseInterceptors(BandwidthInterceptor)
  async download(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Res() res: Response) {
    const downloadInfo = await this.fileService.getDownloadInfo(id, req.user.userId);
    return this.fileService.processDownload(downloadInfo, res, req.headers.range);
  }

  @Head(':id/download')
  @HttpCode(HttpStatus.OK)
  async checkDownload(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Res() res: Response) {
    await this.fileService.getFileInfo(id, req.user.userId);
    res.status(200).end();
  }

  @Get(':id/stream')
  @UseInterceptors(BandwidthInterceptor)
  async streamMedia(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Res() res: Response) {
    const downloadInfo = await this.fileService.getDownloadInfo(id, req.user.userId);
    return this.fileService.processStream(downloadInfo, req.headers.range as string | undefined, res);
  }

  @Patch(':id/rename')
  rename(@Param('id') id: string, @Body('name') name: string, @Req() req: AuthenticatedRequest) {
    return this.fileService.rename(id, name, req.user.userId);
  }

  @Patch(':id/move')
  move(@Param('id') id: string, @Body('folderId') folderId: string | null, @Req() req: AuthenticatedRequest) {
    return this.fileService.move(id, folderId, req.user.userId);
  }

  @Post(':id/share')
  share(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.fileService.share(id, req.user.userId);
  }

  @Post(':id/unshare')
  unshare(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.fileService.unshare(id, req.user.userId);
  }

  @Public()
  @Get('share/:token')
  getSharedFile(@Param('token') token: string) {
    return this.fileService.getSharedFileInfo(token);
  }

  @Public()
  @UseInterceptors(BandwidthInterceptor)
  @Get('share/:token/download')
  async downloadSharedFile(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const downloadInfo = await this.fileService.getDownloadInfoByToken(token);
    return this.fileService.processDownload(downloadInfo, res, req.headers.range);
  }

  @Public()
  @UseInterceptors(BandwidthInterceptor)
  @Get('share/:token/stream')
  async streamSharedMedia(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const downloadInfo = await this.fileService.getDownloadInfoByToken(token);
    return this.fileService.processStream(downloadInfo, req.headers.range as string | undefined, res);
  }

  @Delete(':id')
  softDelete(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.fileService.softDelete(id, req.user.userId);
  }

  @Get('trash/list')
  listTrash(@Req() req: AuthenticatedRequest) {
    return this.fileService.listTrash(req.user.userId);
  }

  @Patch(':id/restore')
  restore(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.fileService.restore(id, req.user.userId);
  }

  @Delete(':id/permanent')
  permanentDelete(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.fileService.permanentDelete(id, req.user.userId);
  }

  @UseGuards(AdminGuard)
  @Post('admin/reindex-bots')
  async reindexBots() {
    return this.fileService.reindexUnavailableBots();
  }
}
