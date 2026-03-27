import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Req,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3AuthService } from './s3-auth.service';
import { CreateS3CredentialDto } from './dto/create-s3-credential.dto';
import type { AuthenticatedRequest } from '../common/types/request';

/**
 * S3CredentialController — Quản lý S3 Access Keys (per user).
 *
 * Requires JWT auth (via global JwtAuthGuard — NOT S3AuthGuard).
 *
 * Routes:
 *   GET    /s3-credentials          → List user's credentials
 *   POST   /s3-credentials          → Create new credential
 *   DELETE /s3-credentials/:id      → Delete credential
 */
@Controller('s3-credentials')
export class S3CredentialController {
  private readonly logger = new Logger(S3CredentialController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3AuthService: S3AuthService,
  ) {}

  /**
   * GET /s3-credentials — Liệt kê credentials của user hiện tại
   */
  @Get()
  async listCredentials(@Req() req: AuthenticatedRequest) {
    const userId = req.user.userId;
    const credentials = await this.prisma.s3Credential.findMany({
      where: { userId, isActive: true },
      select: {
        id: true,
        accessKeyId: true,
        label: true,
        isActive: true,
        createdAt: true,
        // secretAccessKey is NOT returned for security
      },
      orderBy: { createdAt: 'desc' },
    });
    return credentials;
  }

  /**
   * POST /s3-credentials — Tạo mới credential
   * Returns secretAccessKey ONCE (không lưu plaintext)
   */
  @Post()
  async createCredential(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateS3CredentialDto,
  ) {
    const userId = req.user.userId;

    const accessKeyId = this.s3AuthService.generateAccessKeyId();
    const plainSecret = this.s3AuthService.generateSecretAccessKey();
    const encryptedSecret = this.s3AuthService.encryptSecret(plainSecret);

    const credential = await this.prisma.s3Credential.create({
      data: {
        userId,
        accessKeyId,
        secretAccessKey: encryptedSecret,
        label: body.label || 'Default',
      },
    });

    this.logger.log(
      `S3 credential created: accessKeyId=${accessKeyId} (userId: ${userId}, label: "${body.label || 'Default'}")`,
    );

    // Return plaintext secret ONLY on creation
    return {
      id: credential.id,
      accessKeyId: credential.accessKeyId,
      secretAccessKey: plainSecret, // shown once only
      label: credential.label,
      createdAt: credential.createdAt,
      note: 'Save your Secret Access Key now. It will not be shown again.',
    };
  }

  /**
   * DELETE /s3-credentials/:id — Xoá (deactivate) credential
   */
  @Delete(':id')
  async deleteCredential(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const userId = req.user.userId;

    const credential = await this.prisma.s3Credential.findFirst({
      where: { id, userId },
    });

    if (!credential) throw new NotFoundException('Credential not found');

    await this.prisma.s3Credential.update({
      where: { id },
      data: { isActive: false },
    });

    this.logger.log(
      `S3 credential deactivated: accessKeyId=${credential.accessKeyId} (userId: ${userId})`,
    );

    return { success: true, message: 'Credential deactivated' };
  }
}
