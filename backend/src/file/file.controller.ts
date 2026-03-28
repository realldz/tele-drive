import { Controller, Logger, Get, Post, Patch, Delete, Param, Req, Res, Query, UseInterceptors, UseGuards, ParseIntPipe, Body, Head, HttpCode, HttpStatus, UploadedFile, UnauthorizedException, SetMetadata } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { FileService } from './file.service';
import { CryptoService } from '../crypto/crypto.service';
import { MAX_CHUNK_SIZE } from '../config/upload.config';
import { BandwidthInterceptor } from '../common/bandwidth.interceptor';
import { Public } from '../auth/public.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { InitUploadDto } from './dto/init-upload.dto';
import { getClientIp } from '../common/utils/get-client-ip';
import type { AuthenticatedRequest } from '../common/types/request';
import type { Response, Request } from 'express';

const multerOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_CHUNK_SIZE + 1024 * 1024 },
};

@Controller('files')
export class FileController {
  private readonly logger = new Logger(FileController.name);

  constructor(
    private readonly fileService: FileService,
    private readonly cryptoService: CryptoService,
  ) {}

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

  // ── Signed Download Token ──────────────────────────────────────────────

  @Post(':id/download-token')
  @UseInterceptors(BandwidthInterceptor)
  @SetMetadata('BANDWIDTH_CHECK_ONLY', true)
  async generateDownloadToken(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.fileService.generateDownloadToken(id, req.user.userId);
  }

  @Public()
  @Post('share/:token/download-token')
  @UseInterceptors(BandwidthInterceptor)
  @SetMetadata('BANDWIDTH_CHECK_ONLY', true)
  async generateShareDownloadToken(@Param('token') token: string) {
    return this.fileService.generateShareDownloadToken(token);
  }

  @Public()
  @UseInterceptors(BandwidthInterceptor)
  @Get('d/:token')
  async downloadBySigned(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const downloadInfo = await this.fileService.downloadBySignedToken(token);
    return this.fileService.processDownload(downloadInfo, res, req.headers.range);
  }

  @Public()
  @Head('d/:token')
  @HttpCode(HttpStatus.OK)
  async checkSignedToken(@Param('token') token: string, @Res() res: Response) {
    const payload = this.cryptoService.verifySignedToken(token);
    if (!payload) throw new UnauthorizedException('Invalid or expired download link');
    res.status(200).end();
  }

  // ── Stream Cookie ──────────────────────────────────────────────────────

  @Post('stream-cookie')
  @UseInterceptors(BandwidthInterceptor)
  @SetMetadata('BANDWIDTH_CHECK_ONLY', true)
  async issueStreamCookie(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const ttl = await this.fileService.getStreamTtl();
    const token = this.cryptoService.createStreamCookieToken(req.user.userId, ttl);
    res.cookie('stream_token', token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: ttl * 1000,
    });
    this.logger.debug(`Stream cookie issued for user ${req.user.userId}, ttl=${ttl}s`);
    return { expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), ttl };
  }

  @Public()
  @Post('stream-cookie/guest')
  @UseInterceptors(BandwidthInterceptor)
  @SetMetadata('BANDWIDTH_CHECK_ONLY', true)
  async issueGuestStreamCookie(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const ip = getClientIp(req);
    const ttl = await this.fileService.getStreamTtl();
    const token = this.cryptoService.createStreamCookieToken(`guest:${ip}`, ttl);
    res.cookie('stream_token', token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: ttl * 1000,
    });
    this.logger.debug(`Guest stream cookie issued for ip ${ip}, ttl=${ttl}s`);
    return { expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), ttl };
  }

  @Public()
  @Delete('stream-cookie')
  async clearStreamCookie(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('stream_token', { path: '/' });
    return { success: true };
  }

  @Public()
  @UseInterceptors(BandwidthInterceptor)
  @Get('stream/:id')
  async streamByCookie(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const cookiePayload = this.verifyStreamCookie(req);
    const sub = cookiePayload.sub;

    // User stream: verify ownership. Guest stream: allow if subject starts with 'guest:'
    const downloadInfo = sub.startsWith('guest:')
      ? await this.fileService.getStreamInfoByGuest(id)
      : await this.fileService.getStreamInfoByOwner(id, sub);

    return this.fileService.processStream(downloadInfo, req.headers.range as string | undefined, res);
  }

  @Public()
  @UseInterceptors(BandwidthInterceptor)
  @Get('share/stream/:shareToken')
  async streamSharedByCookie(@Param('shareToken') shareToken: string, @Req() req: Request, @Res() res: Response) {
    this.verifyStreamCookie(req);
    const downloadInfo = await this.fileService.getShareStreamInfo(shareToken);
    return this.fileService.processStream(downloadInfo, req.headers.range as string | undefined, res);
  }

  // ── Legacy routes (kept for backwards compatibility) ───────────────────

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

  // ── File CRUD ──────────────────────────────────────────────────────────

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

  // ── Helpers ────────────────────────────────────────────────────────────

  private verifyStreamCookie(req: Request): { sub: string; exp: number } {
    const token = req.cookies?.stream_token;
    if (!token) throw new UnauthorizedException('Stream cookie required');
    const payload = this.cryptoService.verifyStreamCookieToken(token);
    if (!payload) throw new UnauthorizedException('Invalid or expired stream cookie');
    return payload;
  }

}
