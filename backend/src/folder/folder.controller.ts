import { Controller, Get, Post, Delete, Patch, Body, Param, Query, Req, Res, UseInterceptors } from '@nestjs/common';
import { FolderService } from './folder.service';
import { FileService } from '../file/file.service';
import { Public } from '../auth/public.decorator';
import { BandwidthInterceptor } from '../common/bandwidth.interceptor';
import type { Response } from 'express';

@Controller('folders')
export class FolderController {
  constructor(
    private readonly folderService: FolderService,
    private readonly fileService: FileService,
  ) {}

  @Post()
  create(@Body() body: { name: string; parentId?: string }, @Req() req: any) {
    return this.folderService.create(body.name, req.user.userId, body.parentId || undefined);
  }

  // Lấy toàn bộ Folders và Files trực thuộc — scope theo user
  @Get('content')
  getContent(@Query('folderId') folderId: string | undefined, @Req() req: any) {
    return this.folderService.getContent(req.user.userId, folderId);
  }

  // Danh sách folders trong thùng rác
  @Get('trash/list')
  listTrash(@Req() req: any) {
    return this.folderService.listTrash(req.user.userId);
  }

  // Danh sách các thư mục con và file con — scope theo user
  @Get()
  findAll(@Query('parentId') parentId: string | undefined, @Req() req: any) {
    return this.folderService.findAll(req.user.userId, parentId);
  }

  // Lấy danh sách link breadcrumb để vẽ Navigation bar trên Web
  @Get(':id/breadcrumbs')
  getBreadcrumbs(@Param('id') id: string, @Req() req: any) {
    return this.folderService.getBreadcrumbs(id, req.user.userId);
  }

  // Đổi tên folder
  @Patch(':id/rename')
  rename(@Param('id') id: string, @Body('name') name: string, @Req() req: any) {
    return this.folderService.rename(id, name, req.user.userId);
  }

  // Di chuyển folder
  @Patch(':id/move')
  move(@Param('id') id: string, @Body('parentId') parentId: string | null, @Req() req: any) {
    return this.folderService.move(id, parentId, req.user.userId);
  }

  // Soft delete — chuyển vào thùng rác
  @Delete(':id')
  softDelete(@Param('id') id: string, @Req() req: any) {
    return this.folderService.softDelete(id, req.user.userId);
  }

  // Khôi phục folder từ thùng rác
  @Patch(':id/restore')
  restore(@Param('id') id: string, @Req() req: any) {
    return this.folderService.restore(id, req.user.userId);
  }

  // Xoá vĩnh viễn folder (permanent delete từ thùng rác)
  @Delete(':id/permanent')
  permanentDelete(@Param('id') id: string, @Req() req: any) {
    return this.folderService.permanentDelete(id, req.user.userId);
  }

  // Chia sẻ thư mục
  @Post(':id/share')
  share(@Param('id') id: string, @Req() req: any) {
    return this.folderService.share(id, req.user.userId);
  }

  // Huỷ chia sẻ thư mục
  @Post(':id/unshare')
  unshare(@Param('id') id: string, @Req() req: any) {
    return this.folderService.unshare(id, req.user.userId);
  }

  // Lấy nội dung thư mục được chia sẻ (public)
  @Public()
  @Get('share/:token')
  getSharedContent(@Param('token') token: string, @Query('folderId') folderId?: string) {
    return this.folderService.getSharedContent(token, folderId);
  }

  // Tải file trong thư mục chia sẻ (public)
  @Public()
  @UseInterceptors(BandwidthInterceptor)
  @Get('share/:token/download/:fileId')
  async downloadSharedFile(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Res() res: Response
  ) {
    const downloadInfo = await this.folderService.getSharedFileDownloadInfo(token, fileId);
    return this.fileService.processDownload(downloadInfo, res);
  }
}
