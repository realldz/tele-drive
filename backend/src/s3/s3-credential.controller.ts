import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Req,
} from '@nestjs/common';
import { S3CredentialService } from './s3-credential.service';
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
  constructor(private readonly s3CredentialService: S3CredentialService) {}

  @Get()
  async listCredentials(@Req() req: AuthenticatedRequest) {
    return this.s3CredentialService.listCredentials(req.user.userId);
  }

  @Post()
  async createCredential(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateS3CredentialDto,
  ) {
    return this.s3CredentialService.createCredential(req.user.userId, body.label);
  }

  @Delete(':id')
  async deleteCredential(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.s3CredentialService.deleteCredential(id, req.user.userId);
  }
}
