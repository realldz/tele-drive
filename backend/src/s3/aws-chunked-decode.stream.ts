import { Transform, type TransformCallback } from 'stream';

export class AwsChunkedDecodeStream extends Transform {
  public readonly trailers: Record<string, string> = {};

  private buffer = Buffer.alloc(0);
  private expectedChunkSize = 0;
  private state: 'header' | 'data' | 'data_crlf' | 'trailers' | 'done' =
    'header';

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  _flush(callback: TransformCallback) {
    try {
      this.processBuffer(true);
      if (this.state !== 'done') {
        throw new Error('Incomplete aws-chunked stream');
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private processBuffer(flush = false) {
    while (true) {
      if (this.state === 'header') {
        const line = this.readLine();
        if (line === null) {
          if (flush && this.buffer.length > 0)
            throw new Error('Invalid aws-chunked header line');
          return;
        }

        const sizeHex = line.split(';', 1)[0]?.trim();
        if (!sizeHex || !/^[0-9a-fA-F]+$/.test(sizeHex)) {
          throw new Error(`Invalid aws-chunked chunk size: ${line}`);
        }

        this.expectedChunkSize = parseInt(sizeHex, 16);
        this.state = this.expectedChunkSize === 0 ? 'trailers' : 'data';
        continue;
      }

      if (this.state === 'data') {
        if (this.buffer.length < this.expectedChunkSize) {
          return;
        }

        const data = this.buffer.subarray(0, this.expectedChunkSize);
        this.push(data);
        this.buffer = this.buffer.subarray(this.expectedChunkSize);
        this.state = 'data_crlf';
        continue;
      }

      if (this.state === 'data_crlf') {
        if (this.buffer.length < 2) {
          return;
        }
        if (this.buffer[0] !== 0x0d || this.buffer[1] !== 0x0a) {
          throw new Error('Invalid aws-chunked data terminator');
        }
        this.buffer = this.buffer.subarray(2);
        this.state = 'header';
        continue;
      }

      if (this.state === 'trailers') {
        const line = this.readLine();
        if (line === null) {
          if (flush && this.buffer.length > 0)
            throw new Error('Invalid aws-chunked trailer line');
          return;
        }

        if (line === '') {
          this.state = 'done';
          continue;
        }

        const separatorIndex = line.indexOf(':');
        if (separatorIndex === -1) {
          throw new Error(`Invalid aws-chunked trailer header: ${line}`);
        }

        const name = line.slice(0, separatorIndex).trim().toLowerCase();
        const value = line.slice(separatorIndex + 1).trim();
        this.trailers[name] = value;
        continue;
      }

      return;
    }
  }

  private readLine(): string | null {
    const lineEnd = this.buffer.indexOf('\r\n');
    if (lineEnd === -1) return null;

    const line = this.buffer.subarray(0, lineEnd).toString('utf8');
    this.buffer = this.buffer.subarray(lineEnd + 2);
    return line;
  }
}
