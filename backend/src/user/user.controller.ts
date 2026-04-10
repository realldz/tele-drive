import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserService } from './user.service';
import { AdminGuard } from '../auth/admin.guard';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateQuotaDto } from './dto/update-quota.dto';
import { UpdateBandwidthDto } from './dto/update-bandwidth.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import type { AuthenticatedRequest } from '../common/types/request';

@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('me')
  getMe(@Req() req: AuthenticatedRequest) {
    return this.userService.getMe(req.user.userId);
  }

  @Patch('me/password')
  changePassword(
    @Req() req: AuthenticatedRequest,
    @Body() body: ChangePasswordDto,
  ) {
    return this.userService.changePassword(
      req.user.userId,
      body.currentPassword,
      body.newPassword,
    );
  }

  @UseGuards(AdminGuard)
  @Get()
  findAll() {
    return this.userService.findAll();
  }

  @UseGuards(AdminGuard)
  @Patch(':id/quota')
  updateQuota(@Param('id') id: string, @Body() body: UpdateQuotaDto) {
    return this.userService.updateQuota(id, BigInt(body.quota));
  }

  @UseGuards(AdminGuard)
  @Patch(':id/bandwidth-limit')
  updateBandwidthLimit(
    @Param('id') id: string,
    @Body() body: UpdateBandwidthDto,
  ) {
    return this.userService.updateBandwidthLimit(
      id,
      body.dailyBandwidthLimit === null
        ? null
        : BigInt(body.dailyBandwidthLimit),
    );
  }

  @UseGuards(AdminGuard)
  @Delete(':id')
  deleteUser(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.userService.deleteUser(id, req.user.userId);
  }

  @UseGuards(AdminGuard)
  @Patch(':id/role')
  updateRole(
    @Param('id') id: string,
    @Body() body: UpdateRoleDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.userService.updateRole(id, body.role, req.user.userId);
  }

  @UseGuards(AdminGuard)
  @Get(':id/files')
  getUserFiles(@Param('id') id: string) {
    return this.userService.getUserFiles(id);
  }

  @UseGuards(AdminGuard)
  @Delete(':id/files/:fileId')
  deleteUserFile(@Param('id') id: string, @Param('fileId') fileId: string) {
    return this.userService.deleteUserFile(id, fileId);
  }

  @UseGuards(AdminGuard)
  @Patch(':id/password')
  adminResetPassword(@Param('id') id: string, @Body() body: ResetPasswordDto) {
    return this.userService.adminResetPassword(id, body.newPassword);
  }
}
