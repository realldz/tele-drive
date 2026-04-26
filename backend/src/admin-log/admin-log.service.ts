import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { createGunzip } from 'zlib';
import type { Readable } from 'stream';
import { ReadLogQueryDto } from './dto/read-log-query.dto';

type LogKind = 'combined' | 'error' | 'unknown';

export interface AdminLogFile {
  name: string;
  kind: LogKind;
  compressed: boolean;
  sizeBytes: number;
  modifiedAt: string;
}

export interface AdminLogEntry {
  timestamp?: string;
  level?: string;
  context?: string;
  message: string;
  stack?: string;
  ms?: string;
  raw?: unknown;
}

@Injectable()
export class AdminLogService {
  private readonly logger = new Logger(AdminLogService.name);

  private getLogDir(): string {
    return (
      process.env.LOG_DIR || path.join(__dirname, '..', '..', '..', '.logs')
    );
  }

  async listLogFiles(): Promise<AdminLogFile[]> {
    const logDir = this.getLogDir();

    let names: string[];
    try {
      names = await fs.promises.readdir(logDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to read log directory ${logDir}: ${message}`);
      throw new InternalServerErrorException('Failed to read log directory');
    }

    const files = await Promise.all(
      names
        .filter((name) => name.endsWith('.log') || name.endsWith('.gz'))
        .map(async (name) => {
          const fullPath = path.join(logDir, name);
          const stat = await fs.promises.stat(fullPath);
          if (!stat.isFile()) {
            return null;
          }

          return {
            name,
            kind: this.getLogKind(name),
            compressed: name.endsWith('.gz'),
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          } satisfies AdminLogFile;
        }),
    );

    return files
      .filter((file): file is AdminLogFile => file !== null)
      .sort(
        (a, b) =>
          b.modifiedAt.localeCompare(a.modifiedAt) ||
          b.name.localeCompare(a.name),
      );
  }

  async readLogFile(query: ReadLogQueryDto): Promise<{
    file: string;
    compressed: boolean;
    entries: AdminLogEntry[];
  }> {
    const file = await this.resolveAllowedFile(query.file);
    const entries = file.compressed
      ? await this.readCompressedLog(file.absolutePath, query)
      : await this.readPlainLog(file.absolutePath, query);

    return {
      file: file.name,
      compressed: file.compressed,
      entries,
    };
  }

  private getLogKind(name: string): LogKind {
    if (name.startsWith('combined-')) return 'combined';
    if (name.startsWith('error-')) return 'error';
    return 'unknown';
  }

  private async resolveAllowedFile(fileName: string): Promise<{
    name: string;
    absolutePath: string;
    compressed: boolean;
  }> {
    if (!fileName || fileName.includes('/') || fileName.includes('\\')) {
      throw new BadRequestException('Invalid log filename');
    }

    const files = await this.listLogFiles();
    const match = files.find((file) => file.name === fileName);
    if (!match) {
      throw new NotFoundException('Log file not found');
    }

    return {
      name: match.name,
      absolutePath: path.join(this.getLogDir(), match.name),
      compressed: match.compressed,
    };
  }

  private async readPlainLog(
    filePath: string,
    query: ReadLogQueryDto,
  ): Promise<AdminLogEntry[]> {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    return this.collectEntriesFromStream(stream, query);
  }

  private async readCompressedLog(
    filePath: string,
    query: ReadLogQueryDto,
  ): Promise<AdminLogEntry[]> {
    const stream = fs.createReadStream(filePath).pipe(createGunzip());
    return this.collectEntriesFromStream(stream, query);
  }

  private async collectEntriesFromStream(
    stream: Readable,
    query: ReadLogQueryDto,
  ): Promise<AdminLogEntry[]> {
    const limit = query.limit ?? 100;
    const entries: AdminLogEntry[] = [];
    let remainder = '';

    try {
      for await (const chunk of stream) {
        remainder += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        const lines = remainder.split(/\r?\n/);
        remainder = lines.pop() ?? '';

        for (const line of lines) {
          const entry = this.parseLogLine(line);
          if (!entry) continue;
          if (!this.matchesFilters(entry, query.level, query.search)) continue;
          this.pushRingBuffer(entries, entry, limit);
        }
      }

      if (remainder.trim()) {
        const entry = this.parseLogLine(remainder);
        if (entry && this.matchesFilters(entry, query.level, query.search)) {
          this.pushRingBuffer(entries, entry, limit);
        }
      }

      return entries;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to read log stream: ${message}`);
      throw new InternalServerErrorException('Failed to read log file');
    }
  }

  private parseLogLine(line: string): AdminLogEntry | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      return {
        timestamp:
          typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
        level: typeof parsed.level === 'string' ? parsed.level : undefined,
        context:
          typeof parsed.context === 'string' ? parsed.context : undefined,
        message: this.extractMessage(parsed),
        stack: typeof parsed.stack === 'string' ? parsed.stack : undefined,
        ms: typeof parsed.ms === 'string' ? parsed.ms : undefined,
        raw: parsed,
      };
    } catch {
      return {
        level: 'unknown',
        message: trimmed,
        raw: trimmed,
      };
    }
  }

  private extractMessage(parsed: Record<string, unknown>): string {
    if (typeof parsed.message === 'string') {
      return parsed.message;
    }

    return JSON.stringify(parsed);
  }

  private matchesFilters(
    entry: AdminLogEntry,
    level?: string,
    search?: string,
  ): boolean {
    if (level && (entry.level || '').toLowerCase() !== level.toLowerCase()) {
      return false;
    }

    if (!search) {
      return true;
    }

    const haystack = [
      entry.timestamp,
      entry.level,
      entry.context,
      entry.message,
      entry.stack,
      typeof entry.raw === 'string'
        ? entry.raw
        : JSON.stringify(entry.raw ?? ''),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(search.toLowerCase());
  }

  private pushRingBuffer<T>(buffer: T[], item: T, limit: number): void {
    buffer.push(item);
    if (buffer.length > limit) {
      buffer.shift();
    }
  }
}
