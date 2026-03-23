import { Controller, Get, Patch, Delete, Param, Body, Req, UseGuards } from '@nestjs/common';
import { UserService } from './user.service';
import { AdminGuard } from '../auth/admin.guard';

@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  /**
   * GET /users/me — Profile user hiện tại (authenticated user)
   */
  @Get('me')
  getMe(@Req() req: any) {
    return this.userService.getMe(req.user.userId);
  }

  /**
   * PATCH /users/me/password — User tự đổi mật khẩu
   */
  @Patch('me/password')
  changePassword(
    @Req() req: any,
    @Body('currentPassword') currentPassword: string,
    @Body('newPassword') newPassword: string,
  ) {
    return this.userService.changePassword(req.user.userId, currentPassword, newPassword);
  }

  /**
   * GET /users — Danh sách tất cả user (Admin only)
   */
  @UseGuards(AdminGuard)
  @Get()
  findAll() {
    return this.userService.findAll();
  }

  /**
   * PATCH /users/:id/quota — Cập nhật quota (Admin only)
   * Body: { quota: number } (bytes)
   */
  @UseGuards(AdminGuard)
  @Patch(':id/quota')
  updateQuota(
    @Param('id') id: string,
    @Body('quota') quota: string,
  ) {
    return this.userService.updateQuota(id, BigInt(quota));
  }

  /**
   * PATCH /users/:id/bandwidth-limit — Cập nhật bandwidth limit (Admin only)
   * Body: { dailyBandwidthLimit: number | null } (bytes/day, null = system default)
   */
  @UseGuards(AdminGuard)
  @Patch(':id/bandwidth-limit')
  updateBandwidthLimit(
    @Param('id') id: string,
    @Body('dailyBandwidthLimit') dailyBandwidthLimit: string | null,
  ) {
    return this.userService.updateBandwidthLimit(
      id,
      dailyBandwidthLimit === null ? null : BigInt(dailyBandwidthLimit),
    );
  }

  /**
   * DELETE /users/:id — Xoá user và tất cả data (Admin only)
   */
  @UseGuards(AdminGuard)
  @Delete(':id')
  deleteUser(@Param('id') id: string, @Req() req: any) {
    return this.userService.deleteUser(id, req.user.userId);
  }

  /**
   * PATCH /users/:id/role — Cập nhật role (Admin only)
   */
  @UseGuards(AdminGuard)
  @Patch(':id/role')
  updateRole(
    @Param('id') id: string,
    @Body('role') role: string,
    @Req() req: any,
  ) {
    return this.userService.updateRole(id, role, req.user.userId);
  }

  /**
   * GET /users/:id/files — Xem danh sách file của user (Admin only)
   */
  @UseGuards(AdminGuard)
  @Get(':id/files')
  getUserFiles(@Param('id') id: string) {
    return this.userService.getUserFiles(id);
  }

  /**
   * DELETE /users/:id/files/:fileId — Xoá file của user (Admin only)
   */
  @UseGuards(AdminGuard)
  @Delete(':id/files/:fileId')
  deleteUserFile(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
  ) {
    return this.userService.deleteUserFile(id, fileId);
  }

  /**
   * PATCH /users/:id/password — Admin reset mật khẩu cho user (Admin only)
   */
  @UseGuards(AdminGuard)
  @Patch(':id/password')
  adminResetPassword(
    @Param('id') id: string,
    @Body('newPassword') newPassword: string,
  ) {
    return this.userService.adminResetPassword(id, newPassword);
  }
}
