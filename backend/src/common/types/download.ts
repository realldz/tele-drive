interface ChunkInfo {
  id: string;
  telegramFileId: string | null;
  botId: bigint;
  telegramMessageId: number | null;
  iv: Buffer | null;
  size: number;
  isBuffered?: boolean;
  tempStorageKey?: string | null;
}

export interface SingleFileDownloadInfo {
  filename: string;
  size: bigint | number;
  telegramFileId: string;
  botId: bigint;
  telegramMessageId: number | null;
  isEncrypted: boolean;
  dek: Buffer | null;
  iv: Buffer | null;
  mimeType: string;
  isChunked?: false;
}

export interface ChunkedDownloadInfo {
  filename: string;
  size: bigint | number;
  isChunked: true;
  chunks: ChunkInfo[];
  isEncrypted: boolean;
  dek: Buffer | null;
  mimeType: string;
}

export interface BufferedDownloadInfo {
  filename: string;
  size: bigint | number;
  isBuffered: true;
  tempStorageKey: string;
  mimeType: string;
  isChunked?: boolean;
}

export type DownloadInfo =
  | SingleFileDownloadInfo
  | ChunkedDownloadInfo
  | BufferedDownloadInfo;
