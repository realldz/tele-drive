import { Controller, Logger, Get, Post, Patch, Delete, Param, Req, Res, UseInterceptors, UseGuards, ParseIntPipe, Body, Head, HttpCode, HttpStatus, HttpException, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { FileService } from './file.service';
import { MAX_CHUNK_SIZE } from '../config/upload.config';
import { BandwidthInterceptor } from '../common/bandwidth.interceptor';
import { Public } from '../auth/public.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { InitUploadDto } from './dto/init-upload.dto';
import type { Response, Request } from 'express';
import { Readable } from 'stream';

const multerOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_CHUNK_SIZE + 1024 * 1024 },
};

@Controller('files')
export class FileController {
  private readonly logger = new Logger(FileController.name);

  constructor(private readonly fileService: FileService) {}

  /**
   * GET /files/config — Frontend gọi để biết maxChunkSize + maxConcurrentChunks
   */
  @Public()
  @Get('config')
  async getConfig() {
    return {
      maxChunkSize: MAX_CHUNK_SIZE,
      maxConcurrentChunks: await this.fileService.getMaxConcurrentChunks(),
    };
  }

  /**
   * POST /files/upload — Upload file nhỏ (giữ Multer buffer cho backward compatible)
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', multerOptions))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('folderId') folderId: string | undefined,
    @Req() req: any,
  ) {
    return this.fileService.uploadFile(file, req.user.userId, folderId);
  }

  /**
   * POST /files/upload/init — Khởi tạo chunked upload
   */
  @Post('upload/init')
  async initChunkedUpload(
    @Body() body: InitUploadDto,
    @Req() req: any,
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

  /**
   * POST /files/upload/:fileId/chunk/:index — Upload chunk với STREAM PIPE-THROUGH
   */
  @Post('upload/:fileId/chunk/:index')
  async uploadChunk(
    @Param('fileId') fileId: string,
    @Param('index', ParseIntPipe) index: number,
    @Req() req: any,
  ) {
    return this.fileService.uploadChunkStream(fileId, index, req.user.userId, req);
  }

  /**
   * POST /files/upload/:fileId/complete — Hoàn tất chunked upload
   */
  @Post('upload/:fileId/complete')
  async completeUpload(@Param('fileId') fileId: string, @Req() req: any) {
    return this.fileService.completeChunkedUpload(fileId, req.user.userId);
  }

  /**
   * POST /files/upload/:fileId/abort — Huỷ upload, xoá chunks đã upload trên Telegram
   */
  @Post('upload/:fileId/abort')
  async abortUpload(@Param('fileId') fileId: string, @Req() req: any) {
    return this.fileService.abortUpload(fileId, req.user.userId);
  }

  /**
   * GET /files/upload/:fileId/status — Kiểm tra trạng thái upload (hỗ trợ resume)
   */
  @Get('upload/:fileId/status')
  async getUploadStatus(@Param('fileId') fileId: string, @Req() req: any) {
    return this.fileService.getUploadedChunks(fileId, req.user.userId);
  }

  /**
   * GET /files/:id/info — Lấy metadata file
   */
  @Get(':id/info')
  getFileInfo(@Param('id') id: string, @Req() req: any) {
    return this.fileService.getFileInfo(id, req.user.userId);
  }

  /**
   * GET /files/:id/download — Tải file (hỗ trợ cả file thường và chunked)
   * BandwidthInterceptor kiểm tra + increment bandwidth trước khi download.
   */
  @Get(':id/download')
  @UseInterceptors(BandwidthInterceptor)
  async download(@Param('id') id: string, @Req() req: any, @Res() res: Response) {
    const downloadInfo = await this.fileService.getDownloadInfo(id, req.user.userId);
    return this.fileService.processDownload(downloadInfo, res, req.headers.range);
  }

  /**
   * HEAD /files/:id/download — Kiểm tra quyền và sự tồn tại của file, không increment bandwidth.
   * Frontend dùng để validate trước khi mở link download trực tiếp.
   */
  @Head(':id/download')
  @HttpCode(HttpStatus.OK)
  async checkDownload(@Param('id') id: string, @Req() req: any, @Res() res: Response) {
    await this.fileService.getFileInfo(id, req.user.userId);
    (res as any).status(200).end();
  }

  /**
   * GET /files/:id/stream — Media streaming endpoint với Range requests
   */
  @Get(':id/stream')
  @UseInterceptors(BandwidthInterceptor)
  async streamMedia(@Param('id') id: string, @Req() req: any, @Res() res: Response) {
    const downloadInfo = await this.fileService.getDownloadInfo(id, req.user.userId);
    return this.fileService.processStream(downloadInfo, req.headers.range as string | undefined, res);
  }



  /**
   * PATCH /files/:id/rename — Đổi tên file
   */
  @Patch(':id/rename')
  rename(@Param('id') id: string, @Body('name') name: string, @Req() req: any) {
    return this.fileService.rename(id, name, req.user.userId);
  }

  /**
   * PATCH /files/:id/move — Di chuyển file
   */
  @Patch(':id/move')
  move(@Param('id') id: string, @Body('folderId') folderId: string | null, @Req() req: any) {
    return this.fileService.move(id, folderId, req.user.userId);
  }

  /**
   * POST /files/:id/share — Tạo share link
   */
  @Post(':id/share')
  share(@Param('id') id: string, @Req() req: any) {
    return this.fileService.share(id, req.user.userId);
  }

  /**
   * POST /files/:id/unshare — Huỷ share link
   */
  @Post(':id/unshare')
  unshare(@Param('id') id: string, @Req() req: any) {
    return this.fileService.unshare(id, req.user.userId);
  }

  /**
   * GET /files/share/:token — Get shared file info (Public)
   */
  @Public()
  @Get('share/:token')
  getSharedFile(@Param('token') token: string) {
    return this.fileService.getSharedFileInfo(token);
  }

  /**
   * GET /files/share/:token/download — Download shared file (Public)
   */
  @Public()
  @UseInterceptors(BandwidthInterceptor)
  @Get('share/:token/download')
  async downloadSharedFile(@Param('token') token: string, @Req() req: any, @Res() res: Response) {
    const downloadInfo = await this.fileService.getDownloadInfoByToken(token);
    return this.fileService.processDownload(downloadInfo, res, req.headers.range);
  }

  /**
   * GET /files/share/:token/stream — Stream shared file (Public)
   */
  @Public()
  @UseInterceptors(BandwidthInterceptor)
  @Get('share/:token/stream')
  async streamSharedMedia(@Param('token') token: string, @Req() req: any, @Res() res: Response) {
    const downloadInfo = await this.fileService.getDownloadInfoByToken(token);
    return this.fileService.processStream(downloadInfo, req.headers.range as string | undefined, res);
  }

  /**
   * DELETE /files/:id — Soft delete (chuyển vào thùng rác)
   */
  @Delete(':id')
  softDelete(@Param('id') id: string, @Req() req: any) {
    return this.fileService.softDelete(id, req.user.userId);
  }

  /**
   * GET /files/trash — Danh sách file trong thùng rác
   */
  @Get('trash/list')
  listTrash(@Req() req: any) {
    return this.fileService.listTrash(req.user.userId);
  }

  /**
   * PATCH /files/:id/restore — Khôi phục file từ thùng rác
   */
  @Patch(':id/restore')
  restore(@Param('id') id: string, @Req() req: any) {
    return this.fileService.restore(id, req.user.userId);
  }

  /**
   * DELETE /files/:id/permanent — Xoá vĩnh viễn file khỏi thùng rác
   */
  @Delete(':id/permanent')
  permanentDelete(@Param('id') id: string, @Req() req: any) {
    return this.fileService.permanentDelete(id, req.user.userId);
  }

  /**
   * POST /files/admin/reindex-bots — Re-index chunks/files từ bot không còn available
   */
  @UseGuards(AdminGuard)
  @Post('admin/reindex-bots')
  async reindexBots() {
    return this.fileService.reindexUnavailableBots();
  }
}
