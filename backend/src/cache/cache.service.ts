import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async invalidateFile(fileId: string): Promise<void> {
    try {
      await this.redis.del(`file:${fileId}`);
    } catch (err) {
      this.logger.warn(`Failed to invalidate cache for file:${fileId}`, err);
      try {
        await this.redis.del(`file:${fileId}`);
      } catch (retryErr) {
        this.logger.error(
          `Failed to invalidate cache on retry for file:${fileId}`,
          retryErr,
        );
      }
    }
  }

  async invalidateUserQuota(userId: string): Promise<void> {
    try {
      await this.redis.del(`user:${userId}:quota`);
    } catch (err) {
      this.logger.warn(
        `Failed to invalidate quota cache for user:${userId}`,
        err,
      );
    }
  }

  async setFileMetadata(
    fileId: string,
    metadata: Record<string, any>,
  ): Promise<void> {
    try {
      await this.redis.set(
        `file:${fileId}`,
        JSON.stringify(metadata),
        'EX',
        3600,
      );
    } catch (err) {
      this.logger.warn(`Failed to set cache for file:${fileId}`, err);
    }
  }

  async getFileMetadata(fileId: string): Promise<Record<string, any> | null> {
    try {
      const data = await this.redis.get(`file:${fileId}`);
      return data ? (JSON.parse(data) as Record<string, any>) : null;
    } catch (err) {
      this.logger.warn(`Failed to get cache for file:${fileId}`, err);
      return null;
    }
  }

  async setOneTimeToken(
    token: string,
    data: { fileId: string; userId: string; type: 'download' | 'upload' },
    ttlSeconds = 300,
  ): Promise<void> {
    await this.redis.set(
      `token:${token}`,
      JSON.stringify({ ...data, expiresAt: Date.now() + ttlSeconds * 1000 }),
      'EX',
      ttlSeconds,
    );
  }

  async consumeOneTimeToken(
    token: string,
  ): Promise<{ fileId: string; userId: string; type: string } | null> {
    const data = await this.redis.get(`token:${token}`);
    if (!data) return null;
    await this.redis.del(`token:${token}`);
    return JSON.parse(data) as {
      fileId: string;
      userId: string;
      type: string;
    };
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(
      `lock:${key}`,
      '1',
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }

  async releaseLock(key: string): Promise<void> {
    await this.redis.del(`lock:${key}`);
  }
}
