import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async invalidateFile(fileId: string): Promise<void> {
    const key = `file:${fileId}`;
    let success = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.redis.del(key);
        success = true;
        break;
      } catch (err) {
        this.logger.warn(
          `Failed to invalidate cache for ${key} (attempt ${attempt})`,
          err,
        );
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        }
      }
    }

    if (!success) {
      this.logger.error(
        `CRITICAL: Failed to invalidate cache for ${key} after 3 attempts`,
      );
    }
  }

  async invalidateUserQuota(userId: string): Promise<void> {
    const key = `user:${userId}:quota`;
    let success = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.redis.del(key);
        success = true;
        break;
      } catch (err) {
        this.logger.warn(
          `Failed to invalidate quota cache for ${key} (attempt ${attempt})`,
          err,
        );
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        }
      }
    }

    if (!success) {
      this.logger.error(
        `CRITICAL: Failed to invalidate quota cache for ${key} after 3 attempts`,
      );
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
