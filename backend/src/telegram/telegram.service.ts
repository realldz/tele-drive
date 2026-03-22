import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { Readable } from 'stream';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly chatId: string;

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly configService: ConfigService,
  ) {
    this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID') || '';
  }

  /**
   * Upload file từ Buffer (dùng cho file nhỏ, giữ backward compatible)
   */
  async uploadFile(buffer: Buffer, filename: string): Promise<{ fileId: string; messageId: number }> {
    const response = await this.bot.telegram.sendDocument(this.chatId, {
      source: buffer,
      filename: filename,
    });
    
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
   * Dùng cho chunked upload: Client → [stream pipe] → Telegram đồng thời.
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

  async getFileLink(fileId: string): Promise<string> {
    const link = await this.bot.telegram.getFileLink(fileId);
    this.logger.debug(`Retrieved file link for fileId: ${fileId}`);
    return link.toString();
  }

  async deleteMessage(messageId: number): Promise<void> {
    try {
      await this.bot.telegram.deleteMessage(this.chatId, messageId);
      this.logger.debug(`Deleted Telegram message: ${messageId}`);
    } catch (error) {
      this.logger.warn(`Failed to delete Telegram message ${messageId}: ${error}`);
    }
  }
}
