interface ChunkInfo {
  id: string;
  telegramFileId: string;
  botIndex: number;
  telegramMessageId: number | null;
  iv: Buffer | null;
  size: number;
}

export interface SingleFileDownloadInfo {
  filename: string;
  size: bigint | number;
  telegramFileId: string;
  botIndex: number;
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

export type DownloadInfo = SingleFileDownloadInfo | ChunkedDownloadInfo;
