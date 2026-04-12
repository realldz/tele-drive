import {
  Controller,
  Logger,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Req,
  Res,
  Query,
  UseInterceptors,
  UseGuards,
  ParseIntPipe,
  Body,
  Head,
  HttpCode,
  HttpStatus,
  UploadedFile,
  UnauthorizedException,
  SetMetadata,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { FileService } from './file.service';
import { CryptoService } from '../crypto/crypto.service';
import { MAX_CHUNK_SIZE } from '../config/upload.config';
import { BandwidthInterceptor } from '../common/bandwidth.interceptor';
import { StreamCookieGuard } from '../common/guards/stream-cookie.guard';
import { Public } from '../auth/public.decorator';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { InitUploadDto } from './dto/init-upload.dto';
import { getClientIp } from '../common/utils/get-client-ip';
import type { AuthenticatedRequest } from '../common/types/request';
import type { Response, Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import type { ConflictAction } from '../common/name-conflict.service';
import { TrashCleanupService } from '../common/trash-cleanup.service';

const multerOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_CHUNK_SIZE + 1024 * 1024 },
};

@SkipThrottle()
@Controller('files')
export class FileController {
  private readonly logger = new Logger(FileController.name);

  constructor(
    private readonly fileService: FileService,
    private readonly cryptoService: CryptoService,
    private readonly trashCleanupService: TrashCleanupService,
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
    @Query('onConflict')
    onConflict: 'overwrite' | 'rename' | 'error' | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const result = await this.fileService.uploadFile(
      file,
      req.user.userId,
      folderId,
      onConflict as ConflictAction | undefined,
    );
    this.logger.log(
      `File uploaded: name="${file.originalname}", size=${file.size}, userId=${req.user.userId}, folderId=${folderId || 'root'}`,
    );
    return result;
  }

  @Post('upload/init')
  async initChunkedUpload(
    @Body() body: InitUploadDto,
    @Query('onConflict')
    onConflict: 'overwrite' | 'rename' | 'error' | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.fileService.initChunkedUpload(
      body.filename,
      body.size,
      body.mimeType,
      body.totalChunks,
      req.user.userId,
      body.folderId,
      onConflict as ConflictAction | undefined,
    );
  }

  @Post('upload/:fileId/chunk/:index')
  async uploadChunk(
    @Param('fileId') fileId: string,
    @Param('index', ParseIntPipe) index: number,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.fileService.uploadChunkStream(
      fileId,
      index,
      req.user.userId,
      req,
    );
  }

  @Post('upload/:fileId/complete')
  async completeUpload(
    @Param('fileId') fileId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const result = await this.fileService.completeChunkedUpload(
      fileId,
      req.user.userId,
    );
    this.logger.log(
      `Chunked upload completed: fileId=${fileId}, userId=${req.user.userId}`,
    );
    return result;
  }

  @Post('upload/:fileId/abort')
  async abortUpload(
    @Param('fileId') fileId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const result = await this.fileService.abortUpload(fileId, req.user.userId);
    this.logger.log(
      `Upload aborted: fileId=${fileId}, userId=${req.user.userId}`,
    );
    return result;
  }

  @Get('upload/:fileId/status')
  async getUploadStatus(
    @Param('fileId') fileId: string,
    @Req() req: AuthenticatedRequest,
  ) {
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
  async generateDownloadToken(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.fileService.generateDownloadToken(id, req.user.userId);
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @Post('share/:token/download-token')
  @UseInterceptors(BandwidthInterceptor)
  @SetMetadata('BANDWIDTH_CHECK_ONLY', true)
  async generateShareDownloadToken(@Param('token') token: string) {
    return this.fileService.generateShareDownloadToken(token);
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @UseInterceptors(BandwidthInterceptor)
  @Get('d/:token')
  async downloadBySigned(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const downloadInfo = await this.fileService.downloadBySignedToken(token);
    return this.fileService.processDownload(
      downloadInfo,
      res,
      req.headers.range,
    );
  }

  @Public()
  @Head('d/:token')
  @HttpCode(HttpStatus.OK)
  async checkSignedToken(@Param('token') token: string, @Res() res: Response) {
    const payload = this.cryptoService.verifySignedToken(token);
    if (!payload)
      throw new UnauthorizedException('Invalid or expired download link');
    res.status(200).end();
  }

  // ── Stream Cookie ──────────────────────────────────────────────────────

  @Post('stream-cookie')
  @UseInterceptors(BandwidthInterceptor)
  @SetMetadata('BANDWIDTH_CHECK_ONLY', true)
  async issueStreamCookie(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ttl = await this.fileService.getStreamTtl();
    const token = this.cryptoService.createStreamCookieToken(
      req.user.userId,
      ttl,
    );
    res.cookie('stream_token', token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: ttl * 1000,
    });
    this.logger.debug(
      `Stream cookie issued for user ${req.user.userId}, ttl=${ttl}s`,
    );
    return { expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), ttl };
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @Post('stream-cookie/guest')
  @UseInterceptors(BandwidthInterceptor)
  @SetMetadata('BANDWIDTH_CHECK_ONLY', true)
  async issueGuestStreamCookie(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const typedReq = req as unknown as AuthenticatedRequest;
    const ttl = await this.fileService.getStreamTtl();
    const subject = typedReq.user?.userId ?? `guest:${getClientIp(req)}`;
    const token = this.cryptoService.createStreamCookieToken(subject, ttl);
    res.cookie('stream_token', token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: ttl * 1000,
    });
    this.logger.debug(`Stream cookie issued for ${subject}, ttl=${ttl}s`);
    return { expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), ttl };
  }

  @Public()
  @Delete('stream-cookie')
  async clearStreamCookie(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('stream_token', { path: '/' });
    return { success: true };
  }

  @Public()
  @UseGuards(StreamCookieGuard)
  @UseInterceptors(BandwidthInterceptor)
  @Get('stream/:id')
  async streamByCookie(
    @Param('id') id: string,
    @Req() req: Request & { streamUser?: { sub: string; exp: number } },
    @Res() res: Response,
  ) {
    const sub = req.streamUser!.sub;

    // User stream: verify ownership. Guest stream: allow if subject starts with 'guest:'
    const downloadInfo = sub.startsWith('guest:')
      ? await this.fileService.getStreamInfoByGuest(id)
      : await this.fileService.getStreamInfoByOwner(id, sub);

    return this.fileService.processStream(downloadInfo, req.headers.range, res);
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @UseGuards(StreamCookieGuard)
  @UseInterceptors(BandwidthInterceptor)
  @Get('share/stream/:shareToken')
  async streamSharedByCookie(
    @Param('shareToken') shareToken: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const downloadInfo = await this.fileService.getShareStreamInfo(shareToken);
    return this.fileService.processStream(downloadInfo, req.headers.range, res);
  }

  // ── Legacy routes (kept for backwards compatibility) ───────────────────

  @Get(':id/download')
  @UseInterceptors(BandwidthInterceptor)
  async download(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    const downloadInfo = await this.fileService.getDownloadInfo(
      id,
      req.user.userId,
    );
    return this.fileService.processDownload(
      downloadInfo,
      res,
      req.headers.range,
    );
  }

  @Head(':id/download')
  @HttpCode(HttpStatus.OK)
  async checkDownload(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    await this.fileService.getFileInfo(id, req.user.userId);
    res.status(200).end();
  }

  @Get(':id/stream')
  @UseInterceptors(BandwidthInterceptor)
  async streamMedia(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    const downloadInfo = await this.fileService.getDownloadInfo(
      id,
      req.user.userId,
    );
    return this.fileService.processStream(downloadInfo, req.headers.range, res);
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @UseInterceptors(BandwidthInterceptor)
  @Get('share/:token/download')
  async downloadSharedFile(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const downloadInfo = await this.fileService.getDownloadInfoByToken(token);
    return this.fileService.processDownload(
      downloadInfo,
      res,
      req.headers.range,
    );
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @UseInterceptors(BandwidthInterceptor)
  @Get('share/:token/stream')
  async streamSharedMedia(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const downloadInfo = await this.fileService.getDownloadInfoByToken(token);
    return this.fileService.processStream(downloadInfo, req.headers.range, res);
  }

  // ── File CRUD ──────────────────────────────────────────────────────────

  @Patch(':id/rename')
  async rename(
    @Param('id') id: string,
    @Body('name') name: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const result = await this.fileService.rename(id, name, req.user.userId);
    this.logger.log(
      `File renamed: id=${id}, userId=${req.user.userId}, name="${name}"`,
    );
    return result;
  }

  @Patch(':id/move')
  async move(
    @Param('id') id: string,
    @Body('folderId') folderId: string | null,
    @Body('conflictAction') conflictAction: ConflictAction | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const result = await this.fileService.move(
      id,
      folderId,
      req.user.userId,
      conflictAction,
    );
    this.logger.log(
      `File moved: id=${id}, userId=${req.user.userId}, folderId=${folderId || 'root'}, conflictAction=${conflictAction || 'error'}`,
    );
    return result;
  }

  @Post(':id/share')
  async share(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const result = await this.fileService.share(id, req.user.userId);
    this.logger.log(`File shared: id=${id}, userId=${req.user.userId}`);
    return result;
  }

  @Post(':id/unshare')
  async unshare(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const result = await this.fileService.unshare(id, req.user.userId);
    this.logger.log(`File unshared: id=${id}, userId=${req.user.userId}`);
    return result;
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @Get('share/:token')
  getSharedFile(@Param('token') token: string, @Req() req: Request) {
    return this.fileService.getSharedFileInfo(token);
  }

  @Delete('trash/empty')
  async emptyTrash(@Req() req: AuthenticatedRequest) {
    const result = await this.fileService.emptyTrash(req.user.userId);
    this.logger.log(`Trash emptied: userId=${req.user.userId}`);
    return result;
  }

  @Post('trash/cleanup')
  @HttpCode(HttpStatus.ACCEPTED)
  async startTrashCleanup(@Req() req: AuthenticatedRequest) {
    return this.trashCleanupService.startCleanup(req.user.userId);
  }

  @Get('trash/cleanup-status')
  async getTrashCleanupStatus(@Req() req: AuthenticatedRequest) {
    return this.trashCleanupService.getCleanupStatus(req.user.userId);
  }

  @Delete(':id')
  async softDelete(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const result = await this.fileService.softDelete(id, req.user.userId);
    this.logger.log(`File soft-deleted: id=${id}, userId=${req.user.userId}`);
    return result;
  }

  @Get('trash/list')
  listTrash(@Req() req: AuthenticatedRequest) {
    return this.fileService.listTrash(req.user.userId);
  }

  @Patch(':id/restore')
  async restore(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const result = await this.fileService.restore(id, req.user.userId);
    this.logger.log(`File restored: id=${id}, userId=${req.user.userId}`);
    return result;
  }

  @Delete(':id/permanent')
  async permanentDelete(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const result = await this.fileService.permanentDelete(id, req.user.userId);
    this.logger.log(
      `File permanently deleted: id=${id}, userId=${req.user.userId}`,
    );
    return result;
  }

  @UseGuards(AdminGuard)
  @Post('admin/reindex-bots')
  async reindexBots() {
    return this.fileService.reindexUnavailableBots();
  }
}
