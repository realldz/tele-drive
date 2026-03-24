import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { Readable } from 'stream';

/** Transient error codes that should trigger a retry */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
]);

/** HTTP status codes worth retrying (Telegram rate-limit / server error) */
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);

/**
 * Extract the retry delay (in ms) from a Telegraf TelegramError.
 * Telegram 429 responses include `parameters.retry_after` (in seconds).
 * For other retryable errors, returns null so the caller uses exponential backoff.
 */
function getRetryAfterMs(err: any): number | null {
  // Telegraf TelegramError: err.parameters?.retry_after (seconds)
  const retryAfterSec: number | undefined = err.parameters?.retry_after;
  if (retryAfterSec && retryAfterSec > 0) {
    return retryAfterSec * 1000;
  }
  // Fallback: parse "retry after N" from description (Telegram 400-based rate limits)
  const desc: string = err.response?.description ?? err.description ?? err.message ?? '';
  const match = desc.match(/retry after (\d+)/i);
  if (match) {
    const secs = parseInt(match[1], 10);
    if (secs > 0) return secs * 1000;
  }
  return null;
}

function isRetryable(err: any): boolean {
  if (!err) return false;
  // Node.js network error codes
  const code: string | undefined = err.code ?? err.cause?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  // Telegraf wraps HTTP errors with response.error_code
  const status: number | undefined =
    err.response?.statusCode ?? err.response?.error_code ?? err.on?.response?.statusCode;
  if (status && RETRYABLE_HTTP.has(status)) return true;
  // Telegram sometimes returns rate limits as error_code 400 with "too Many Requests" in description
  const desc: string = err.response?.description ?? err.description ?? '';
  if (desc.toLowerCase().includes('too many requests')) return true;
  // Message-based heuristic for fetch / undici errors
  const msg: string = String(err.message ?? '');
  if (msg.includes('ECONNRESET') || msg.includes('fetch failed') || msg.includes('terminated')) return true;
  if (msg.toLowerCase().includes('too many requests')) return true;
  return false;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly chatId: string;

  /** Max retry attempts for transient errors */
  private readonly MAX_RETRIES = 3;
  /** Base delay in ms for exponential backoff (used when no Retry-After is provided) */
  private readonly BASE_DELAY_MS = 1000;

  /** In-memory cache: telegramFileId → { url, expiry } */
  private readonly fileLinkCache = new Map<string, { url: string; expiry: number }>();
  /** 50 minutes — Telegram file links are valid ~1 hour */
  private readonly CACHE_TTL_MS = 50 * 60 * 1000;

  /** Concurrency limiter for getFileLink API calls */
  private readonly SEMAPHORE_LIMIT = 3;
  private semaphoreActive = 0;
  private readonly semaphoreQueue: (() => void)[] = [];

  /** Singleflight dedup: prevent duplicate in-flight requests for same fileId */
  private readonly pendingRequests = new Map<string, Promise<string>>();

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly configService: ConfigService,
  ) {
    this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID') || '';
  }

  private async acquireSemaphore(): Promise<void> {
    if (this.semaphoreActive < this.SEMAPHORE_LIMIT) {
      this.semaphoreActive++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.semaphoreQueue.push(() => {
        this.semaphoreActive++;
        resolve();
      });
    });
  }

  private releaseSemaphore(): void {
    this.semaphoreActive--;
    if (this.semaphoreQueue.length > 0) {
      this.semaphoreQueue.shift()!();
    }
  }

  /**
   * Generic retry wrapper.
   * - On 429: waits exactly the duration Telegram specifies via retry_after
   * - On other transient errors: exponential backoff (1s → 2s → 4s)
   */
  private async withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        if (attempt < this.MAX_RETRIES && isRetryable(err)) {
          // Prefer server-specified retry_after for 429, fallback to exponential backoff
          const serverDelay = getRetryAfterMs(err);
          const delay = serverDelay ?? this.BASE_DELAY_MS * Math.pow(2, attempt);
          const is429 = err.response?.error_code === 429 || err.code === 429;
          this.logger.warn(
            `[${operation}] ${is429 ? '429 rate-limited' : 'Transient error'} ` +
            `(attempt ${attempt + 1}/${this.MAX_RETRIES + 1}), ` +
            `retrying in ${delay}ms${serverDelay ? ' (server Retry-After)' : ''}: ` +
            `${err.code || err.message}`,
          );
          await new Promise((r) => setTimeout(r, delay));
        } else {
          break;
        }
      }
    }
    throw lastError;
  }

  /**
   * Upload file từ Buffer (dùng cho file nhỏ, giữ backward compatible)
   */
  async uploadFile(buffer: Buffer, filename: string): Promise<{ fileId: string; messageId: number }> {
    const response = await this.withRetry('uploadFile', () =>
      this.bot.telegram.sendDocument(this.chatId, {
        source: buffer,
        filename: filename,
      }),
    );

    if ('document' in response) {
      this.logger.log(`Uploaded file to Telegram: "${filename}" (fileId: ${response.document.file_id}, size: ${buffer.length})`);
      return {
        fileId: response.document.file_id,
        messageId: response.message_id,
      };
    }
    throw new Error('Telegram Bot API did not return a valid document');
  }

  /**
   * Upload file từ Stream — bytes chảy trực tiếp vào Telegram mà không buffer toàn bộ.
   * NOTE: Streams are not retryable (consumed on first attempt). Caller must handle retry
   * by creating a new stream if needed.
   */
  async uploadStream(stream: Readable, filename: string): Promise<{ fileId: string; messageId: number }> {
    const response = await this.bot.telegram.sendDocument(this.chatId, {
      source: stream,
      filename: filename,
    });

    if ('document' in response) {
      this.logger.debug(`Stream uploaded to Telegram: "${filename}" (fileId: ${response.document.file_id})`);
      return {
        fileId: response.document.file_id,
        messageId: response.message_id,
      };
    }
    throw new Error('Telegram Bot API did not return a valid document');
  }

  async getFileLink(fileId: string, context?: string): Promise<string> {
    const label = context ? `[${context}]` : '';

    // 1. Check cache
    const cached = this.fileLinkCache.get(fileId);
    if (cached && cached.expiry > Date.now()) {
      this.logger.debug(`File link cache HIT ${label} for fileId: ${fileId}`);
      return cached.url;
    }

    // 2. Singleflight dedup — reuse in-flight request for same fileId
    const pending = this.pendingRequests.get(fileId);
    if (pending) {
      this.logger.debug(`File link singleflight JOIN ${label} for fileId: ${fileId}`);
      return pending;
    }

    // 3. Resolve with semaphore
    const promise = this.resolveFileLinkWithSemaphore(fileId, context);
    this.pendingRequests.set(fileId, promise);
    try {
      return await promise;
    } finally {
      this.pendingRequests.delete(fileId);
    }
  }

  private async resolveFileLinkWithSemaphore(fileId: string, context?: string): Promise<string> {
    const label = context ? `getFileLink(${context})` : 'getFileLink';
    const logLabel = context ? ` [${context}]` : '';

    await this.acquireSemaphore();
    try {
      // Double-check cache after acquiring semaphore (another request may have resolved it)
      const cached = this.fileLinkCache.get(fileId);
      if (cached && cached.expiry > Date.now()) {
        this.logger.debug(`File link cache HIT${logLabel} for fileId: ${fileId} (after semaphore)`);
        return cached.url;
      }

      this.logger.debug(`File link cache MISS${logLabel} for fileId: ${fileId} (semaphore: ${this.semaphoreActive}/${this.SEMAPHORE_LIMIT})`);

      const link = await this.withRetry(label, () =>
        this.bot.telegram.getFileLink(fileId),
      );
      let url = link.toString();

      // Telegraf converts Local Bot API absolute paths to file:// URLs,
      // but we need HTTP URLs to fetch from the API server remotely.
      if (url.startsWith('file:')) {
        const apiRoot = this.configService.get<string>('TELEGRAM_API_ROOT') || 'https://api.telegram.org';
        const filePath = new URL(url).pathname;
        url = `${apiRoot}/file/bot${this.bot.telegram.token}${filePath}`;
        this.logger.debug(`Converted file:// URL to HTTP${logLabel}: ${url}`);
      }

      // Cache the result
      this.fileLinkCache.set(fileId, { url, expiry: Date.now() + this.CACHE_TTL_MS });

      return url;
    } finally {
      this.releaseSemaphore();
    }
  }

  async deleteMessage(messageId: number): Promise<void> {
    try {
      await this.withRetry('deleteMessage', () =>
        this.bot.telegram.deleteMessage(this.chatId, messageId),
      );
      this.logger.debug(`Deleted Telegram message: ${messageId}`);
    } catch (error) {
      this.logger.warn(`Failed to delete Telegram message ${messageId}: ${error}`);
    }
  }
}

/**
 * Retry helper for raw fetch() calls (used by FileService to download from Telegram CDN URLs).
 * - On 429: reads the Retry-After header and waits the specified duration
 * - On other transient errors: exponential backoff
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<globalThis.Response> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);

      if (!res.ok && RETRYABLE_HTTP.has(res.status) && attempt < maxRetries) {
        let delay: number;

        if (res.status === 429) {
          // Parse Retry-After header (seconds) from Telegram CDN
          const retryAfterHeader = res.headers.get('Retry-After');
          const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
          delay = !isNaN(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec * 1000
            : baseDelay * Math.pow(2, attempt);
        } else {
          delay = baseDelay * Math.pow(2, attempt);
        }

        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries && isRetryable(err)) {
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}
