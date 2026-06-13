import { Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { S3AuthService } from './s3-auth.service';
import { REDIS_CLIENT } from '../redis/redis.module';

// Cache contract shared with Go (backend-transfer-go/internal/s3auth):
//   key:   s3:cred:{accessKeyId}
//   value: JSON {accessKeyId, secretAccessKey, userId, isActive, found}
// `found` MUST be true for live entries — Go treats found=false as a tombstone.
const CRED_CACHE_PREFIX = 's3:cred:';
const CRED_CACHE_TTL_SEC = 900; // 15 min — matches Go credActiveTTL.

@Injectable()
export class S3CredentialService {
  private readonly logger = new Logger(S3CredentialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3AuthService: S3AuthService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
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

    // Write-through so Go's hot path resolves from Redis without a gRPC round-trip.
    await this.writeCache(accessKeyId, plainSecret, userId);

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

    // Evict so Go re-fetches via gRPC and caches the (now inactive) result.
    await this.evictCache(credential.accessKeyId);

    return { success: true, message: 'Credential deactivated' };
  }

  /**
   * Write a live credential into the shared Redis cache. Non-fatal on failure —
   * Postgres is the source of truth and Go falls back to gRPC GetS3Credential.
   */
  private async writeCache(
    accessKeyId: string,
    plainSecret: string,
    userId: string,
  ): Promise<void> {
    const key = `${CRED_CACHE_PREFIX}${accessKeyId}`;
    const value = JSON.stringify({
      accessKeyId,
      secretAccessKey: plainSecret,
      userId,
      isActive: true,
      found: true,
    });
    try {
      await this.redis.set(key, value, 'EX', CRED_CACHE_TTL_SEC);
      this.logger.debug(
        `S3 cred cache write: accessKeyId=${accessKeyId} userId=${userId} action=write`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `S3 cred cache write failed: accessKeyId=${accessKeyId} error=${message}`,
      );
    }
  }

  /**
   * Remove a credential from the shared Redis cache. Non-fatal on failure —
   * the 15-min TTL bounds staleness even if eviction is missed.
   */
  private async evictCache(accessKeyId: string): Promise<void> {
    const key = `${CRED_CACHE_PREFIX}${accessKeyId}`;
    try {
      await this.redis.del(key);
      this.logger.debug(
        `S3 cred cache evict: accessKeyId=${accessKeyId} action=evict`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `S3 cred cache evict failed: accessKeyId=${accessKeyId} error=${message}`,
      );
    }
  }
}
