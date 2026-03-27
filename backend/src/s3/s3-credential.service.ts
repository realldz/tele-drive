import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3AuthService } from './s3-auth.service';

@Injectable()
export class S3CredentialService {
  private readonly logger = new Logger(S3CredentialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3AuthService: S3AuthService,
  ) {}

  async listCredentials(userId: string) {
    return this.prisma.s3Credential.findMany({
      where: { userId, isActive: true },
      select: {
        id: true,
        accessKeyId: true,
        label: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createCredential(userId: string, label?: string) {
    const accessKeyId = this.s3AuthService.generateAccessKeyId();
    const plainSecret = this.s3AuthService.generateSecretAccessKey();
    const encryptedSecret = this.s3AuthService.encryptSecret(plainSecret);

    const credential = await this.prisma.s3Credential.create({
      data: {
        userId,
        accessKeyId,
        secretAccessKey: encryptedSecret,
        label: label || 'Default',
      },
    });

    this.logger.log(
      `S3 credential created: accessKeyId=${accessKeyId} (userId: ${userId}, label: "${label || 'Default'}")`,
    );

    return {
      id: credential.id,
      accessKeyId: credential.accessKeyId,
      secretAccessKey: plainSecret,
      label: credential.label,
      createdAt: credential.createdAt,
      note: 'Save your Secret Access Key now. It will not be shown again.',
    };
  }

  async deleteCredential(id: string, userId: string) {
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
