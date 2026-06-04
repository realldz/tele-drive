export * from './queue.module';

export const UPLOAD_DISPATCH_QUEUE = 'upload-dispatch';

export interface UploadFileJobData {
  type: 'file';
  recordId: string;
  tempStorageKey: string;
  userId: string;
}

export interface UploadChunkJobData {
  type: 'chunk';
  chunkId: string;
  fileRecordId: string;
  chunkIndex: number;
  tempStorageKey: string;
  userId: string;
}

export type UploadJobData = UploadFileJobData | UploadChunkJobData;
