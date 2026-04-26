import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Telegram } from 'telegraf';
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
  const desc: string =
    err.response?.description ?? err.description ?? err.message ?? '';
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
    err.response?.statusCode ??
    err.response?.error_code ??
    err.on?.response?.statusCode;
  if (status && RETRYABLE_HTTP.has(status)) return true;
  // Telegram sometimes returns rate limits as error_code 400 with "too Many Requests" in description
  const desc: string = err.response?.description ?? err.description ?? '';
  if (desc.toLowerCase().includes('too many requests')) return true;
  // Message-based heuristic for fetch / undici errors
  const msg: string = String(err.message ?? '');
  if (
    msg.includes('ECONNRESET') ||
    msg.includes('fetch failed') ||
    msg.includes('terminated')
  )
    return true;
  if (msg.toLowerCase().includes('too many requests')) return true;
  return false;
}

function isBenignDeleteError(err: unknown): boolean {
  const description = String(
    (
      err as {
        response?: { description?: string };
        description?: string;
        message?: string;
      }
    )?.response?.description ??
      (err as { description?: string; message?: string })?.description ??
      (err as { message?: string })?.message ??
      '',
  ).toLowerCase();

  return (
    description.includes("message can't be deleted") ||
    description.includes('message to delete not found') ||
    description.includes('message identifier is not specified')
  );
}

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private readonly chatId: string;

  /** Max retry attempts for transient errors */
  private readonly MAX_RETRIES = 3;
  /** Base delay in ms for exponential backoff (used when no Retry-After is provided) */
  private readonly BASE_DELAY_MS = 1000;

  /** In-memory cache: telegramFileId → { url, expiry } */
  private readonly fileLinkCache = new Map<
    string,
    { url: string; expiry: number }
  >();
  /** 50 minutes — Telegram file links are valid ~1 hour */
  private readonly CACHE_TTL_MS = 50 * 60 * 1000;

  /** Concurrency limiter for getFileLink API calls */
  private readonly SEMAPHORE_LIMIT = 3;
  private semaphoreActive = 0;
  private readonly semaphoreQueue: (() => void)[] = [];

  /** Singleflight dedup: prevent duplicate in-flight requests for same fileId */
  private readonly pendingRequests = new Map<string, Promise<string>>();

  /** Bot ID map: Telegram numeric bot ID → Telegram client */
  private readonly botMap = new Map<bigint, Telegram>();
  /** Bot ID → token map (for file:// URL conversion) */
  private readonly botTokenMap = new Map<bigint, string>();
  /** Ordered list of bot IDs (dùng cho rate limiter iteration) */
  private readonly botIdList: bigint[] = [];
  /** Main bot's numeric Telegram ID */
  private mainBotId = 0n;

  /** Per-bot sliding window rate limiter for sendDocument calls (botId → timestamps) */
  private readonly sendTimestamps = new Map<bigint, number[]>();
  private readonly SEND_RATE_LIMIT: number;
  private readonly SEND_RATE_WINDOW_MS = 60_000;

  /** Telegram API clients to initialize (populated in constructor, consumed in onModuleInit) */
  private readonly initBots: Telegram[];
  /** Extra bot tokens (lưu lại để build botTokenMap trong onModuleInit) */
  private readonly extraTokens: string[];

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly configService: ConfigService,
  ) {
    this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID') || '';

    const apiRoot =
      this.configService.get<string>('TELEGRAM_API_ROOT') ||
      'https://api.telegram.org';
    this.extraTokens = (
      this.configService.get<string>('TELEGRAM_UPLOAD_BOT_TOKENS') || ''
    )
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    this.initBots = [
      this.bot.telegram, // index 0: main bot
      ...this.extraTokens.map((t) => new Telegram(t, { apiRoot })),
    ];

    this.SEND_RATE_LIMIT = parseInt(
      this.configService.get<string>('TELEGRAM_SEND_RATE_LIMIT') || '18',
      10,
    );

    this.logger.log(
      `Initialized ${this.initBots.length} bot(s), rate limit: ${this.SEND_RATE_LIMIT}/min per bot`,
    );
  }

  async onModuleInit(): Promise<void> {
    // Gọi getMe() cho tất cả bots để lấy numeric ID
    const results = await Promise.allSettled(
      this.initBots.map((botClient) => botClient.getMe()),
    );

    const mainToken: string = (
      this.bot.telegram as unknown as { token: string }
    ).token;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        const botId = BigInt(result.value.id);
        const token = i === 0 ? mainToken : this.extraTokens[i - 1];
        this.botMap.set(botId, this.initBots[i]);
        this.botTokenMap.set(botId, token);
        this.botIdList.push(botId);
        this.sendTimestamps.set(botId, []);
        if (i === 0) this.mainBotId = botId;
        this.logger.log(
          `Bot ${i}: id=${botId}, username=@${result.value.username}`,
        );
      } else {
        this.logger.error(`Failed to getMe() for bot ${i}: ${result.reason}`);
      }
    }

    this.logger.log(
      `Bot ID map ready: ${this.botIdList.length} bot(s) [${this.botIdList.join(', ')}]`,
    );
  }

  /** Number of available bots */
  get botCount(): number {
    return this.botIdList.length;
  }

  /** Check if a bot with the given Telegram ID is currently available */
  isBotAvailable(botId: bigint): boolean {
    return this.botMap.has(botId);
  }

  /** Get list of all available bot IDs */
  get availableBotIds(): bigint[] {
    return [...this.botIdList];
  }

  /** Get the main bot's Telegram numeric ID */
  get mainBotTelegramId(): bigint {
    return this.mainBotId;
  }

  // ─── Rate Limiter ──────────────────────────────────────────────────

  /** Count available slots for a specific bot within the sliding window */
  private getAvailableSlots(botId: bigint): number {
    const now = Date.now();
    const ts = this.sendTimestamps.get(botId);
    if (!ts) return 0;
    while (ts.length > 0 && ts[0] <= now - this.SEND_RATE_WINDOW_MS) {
      ts.shift();
    }
    return this.SEND_RATE_LIMIT - ts.length;
  }

  /**
   * Trả về thời gian chờ (ms) cho đến khi có slot upload tiếp theo.
   * 0 nếu có slot sẵn.
   */
  getWaitTimeMs(): number {
    for (const botId of this.botIdList) {
      if (this.getAvailableSlots(botId) > 0) return 0;
    }
    if (this.botIdList.length === 0) return 0;
    const now = Date.now();
    return Math.max(
      0,
      Math.min(
        ...this.botIdList.map((botId) => {
          const ts = this.sendTimestamps.get(botId);
          if (!ts || ts.length === 0) return 0;
          return ts[0] + this.SEND_RATE_WINDOW_MS - now;
        }),
      ),
    );
  }

  /**
   * Acquire an upload slot: pick the bot with the most available slots.
   * Waits if all bots are at their rate limit.
   * Accepts optional AbortSignal to cancel the wait (e.g., on client disconnect).
   */
  async acquireUploadSlot(
    signal?: AbortSignal,
  ): Promise<{ botClient: Telegram; botId: bigint }> {
    while (true) {
      if (signal?.aborted) throw new Error('Upload cancelled');

      let bestBotId = this.botIdList[0] ?? 0n;
      let bestAvail = 0;
      for (const botId of this.botIdList) {
        const avail = this.getAvailableSlots(botId);
        if (avail > bestAvail) {
          bestAvail = avail;
          bestBotId = botId;
        }
      }
      if (bestAvail > 0) {
        this.sendTimestamps.get(bestBotId)!.push(Date.now());
        this.logger.debug(
          `Upload slot acquired: bot ${bestBotId} (${bestAvail - 1} slots remaining)`,
        );
        return { botClient: this.botMap.get(bestBotId)!, botId: bestBotId };
      }
      // All bots full — wait for the earliest slot to expire
      const now = Date.now();
      const minWait = Math.min(
        ...this.botIdList.map((botId) => {
          const ts = this.sendTimestamps.get(botId);
          if (!ts || ts.length === 0) return 0;
          return ts[0] + this.SEND_RATE_WINDOW_MS - now + 100;
        }),
      );
      this.logger.debug(
        `Rate limiter: all ${this.botIdList.length} bot(s) full, waiting ${minWait}ms`,
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, minWait);
        if (signal) {
          if (signal.aborted) {
            clearTimeout(timer);
            reject(new Error('Upload cancelled'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('Upload cancelled'));
            },
            { once: true },
          );
        }
      });
    }
  }

  // ─── Semaphore for getFileLink ─────────────────────────────────────

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

  // ─── Retry ─────────────────────────────────────────────────────────

  /**
   * Generic retry wrapper.
   * - On 429: waits exactly the duration Telegram specifies via retry_after
   * - On other transient errors: exponential backoff (1s → 2s → 4s)
   */
  private async withRetry<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        if (attempt < this.MAX_RETRIES && isRetryable(err)) {
          // Prefer server-specified retry_after for 429, fallback to exponential backoff
          const serverDelay = getRetryAfterMs(err);
          const delay =
            serverDelay ?? this.BASE_DELAY_MS * Math.pow(2, attempt);
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

  // ─── Upload ────────────────────────────────────────────────────────

  /**
   * Upload file từ Buffer — rate-limited, auto-selects best bot.
   * Accepts optional AbortSignal to cancel the rate-limit wait.
   */
  async uploadFile(
    buffer: Buffer,
    filename: string,
    signal?: AbortSignal,
  ): Promise<{ fileId: string; messageId: number; botId: bigint }> {
    const { botClient, botId } = await this.acquireUploadSlot(signal);

    const response = await this.withRetry('uploadFile', () =>
      botClient.sendDocument(this.chatId, {
        source: buffer,
        filename: filename,
      }),
    );

    if ('document' in response) {
      this.logger.log(
        `Uploaded file to Telegram: "${filename}" (fileId: ${response.document.file_id}, size: ${buffer.length}, bot: ${botId})`,
      );
      return {
        fileId: response.document.file_id,
        messageId: response.message_id,
        botId,
      };
    }
    throw new Error('Telegram Bot API did not return a valid document');
  }

  /**
   * Upload file từ Stream — rate-limited, auto-selects best bot.
   * NOTE: Streams are not retryable (consumed on first attempt). Caller must handle retry
   * by creating a new stream if needed.
   */
  async uploadStream(
    stream: Readable,
    filename: string,
    signal?: AbortSignal,
  ): Promise<{ fileId: string; messageId: number; botId: bigint }> {
    const { botClient, botId } = await this.acquireUploadSlot(signal);

    const response = await botClient.sendDocument(this.chatId, {
      source: stream,
      filename: filename,
    });

    if ('document' in response) {
      this.logger.debug(
        `Stream uploaded to Telegram: "${filename}" (fileId: ${response.document.file_id}, bot: ${botId})`,
      );
      return {
        fileId: response.document.file_id,
        messageId: response.message_id,
        botId,
      };
    }
    throw new Error('Telegram Bot API did not return a valid document');
  }

  // ─── getFileLink ───────────────────────────────────────────────────

  async getFileLink(
    fileId: string,
    botId: bigint = 0n,
    context?: string,
  ): Promise<string> {
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
      this.logger.debug(
        `File link singleflight JOIN ${label} for fileId: ${fileId}`,
      );
      return pending;
    }

    // 3. Resolve with semaphore
    const promise = this.resolveFileLinkWithSemaphore(fileId, botId, context);
    this.pendingRequests.set(fileId, promise);
    try {
      return await promise;
    } finally {
      this.pendingRequests.delete(fileId);
    }
  }

  private async resolveFileLinkWithSemaphore(
    fileId: string,
    botId: bigint,
    context?: string,
  ): Promise<string> {
    const label = context ? `getFileLink(${context})` : 'getFileLink';
    const logLabel = context ? ` [${context}]` : '';
    // Lookup bot bằng botId, fallback về main bot nếu không tìm thấy
    const botClient =
      this.botMap.get(botId) ?? this.botMap.get(this.mainBotId)!;

    await this.acquireSemaphore();
    try {
      // Double-check cache after acquiring semaphore (another request may have resolved it)
      const cached = this.fileLinkCache.get(fileId);
      if (cached && cached.expiry > Date.now()) {
        this.logger.debug(
          `File link cache HIT${logLabel} for fileId: ${fileId} (after semaphore)`,
        );
        return cached.url;
      }

      this.logger.debug(
        `File link cache MISS${logLabel} for fileId: ${fileId} (semaphore: ${this.semaphoreActive}/${this.SEMAPHORE_LIMIT}, bot: ${botId})`,
      );

      const link = await this.withRetry(label, () =>
        botClient.getFileLink(fileId),
      );
      let url = link.toString();

      // Telegraf converts Local Bot API absolute paths to file:// URLs,
      // but we need HTTP URLs to fetch from the API server remotely.
      if (url.startsWith('file:')) {
        const apiRoot =
          this.configService.get<string>('TELEGRAM_API_ROOT') ||
          'https://api.telegram.org';
        const filePath = new URL(url).pathname;
        // Tra token bằng botId map (chính xác bất kể thứ tự config)
        const botToken =
          this.botTokenMap.get(botId) ??
          (this.bot.telegram as unknown as { token: string }).token;
        url = `${apiRoot}/file/bot${botToken}${filePath}`;
        this.logger.debug(`Converted file:// URL to HTTP${logLabel}: ${url}`);
      }

      // Cache the result
      this.fileLinkCache.set(fileId, {
        url,
        expiry: Date.now() + this.CACHE_TTL_MS,
      });

      return url;
    } finally {
      this.releaseSemaphore();
    }
  }

  // ─── Recovery ──────────────────────────────────────────────────────

  /**
   * Forward message gốc qua main bot để lấy file_id mới.
   * Dùng khi bot đã upload chunk không còn available.
   */
  async recoverFileId(
    telegramMessageId: number,
  ): Promise<{ fileId: string; botId: bigint }> {
    const mainBot = this.botMap.get(this.mainBotId)!;
    const forwarded = await this.withRetry('recoverFileId', () =>
      mainBot.forwardMessage(this.chatId, this.chatId, telegramMessageId),
    );
    if (!forwarded || !('document' in forwarded)) {
      throw new Error(
        `Cannot recover: forwarded message ${telegramMessageId} has no document`,
      );
    }
    // Xóa message forward (cleanup)
    mainBot.deleteMessage(this.chatId, forwarded.message_id).catch(() => {});
    this.logger.log(
      `Recovered file_id for message ${telegramMessageId}: ${forwarded.document.file_id} → bot ${this.mainBotId}`,
    );
    return { fileId: forwarded.document.file_id, botId: this.mainBotId };
  }

  // ─── Delete ────────────────────────────────────────────────────────

  async deleteMessage(messageId: number, botId?: bigint): Promise<void> {
    const targetBotId =
      botId && this.botMap.has(botId) ? botId : this.mainBotId;
    const botClient = this.botMap.get(targetBotId) ?? this.bot.telegram;

    try {
      await this.withRetry('deleteMessage', () =>
        botClient.deleteMessage(this.chatId, messageId),
      );
      this.logger.debug(
        `Deleted Telegram message: ${messageId} via bot ${targetBotId}`,
      );
    } catch (error) {
      if (isBenignDeleteError(error)) {
        this.logger.debug(
          `Skipped Telegram message delete ${messageId} via bot ${targetBotId}: ${error}`,
        );
        return;
      }

      this.logger.warn(
        `Failed to delete Telegram message ${messageId} via bot ${targetBotId}: ${error}`,
      );
    }
  }
}

/**
 * Retry helper for raw fetch() calls used by transfer read paths to download from Telegram CDN URLs.
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
          const retryAfterSec = retryAfterHeader
            ? parseInt(retryAfterHeader, 10)
            : NaN;
          delay =
            !isNaN(retryAfterSec) && retryAfterSec > 0
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
