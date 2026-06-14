export type ConflictResolution = 'overwrite' | 'keepBoth' | 'merge' | 'skip';

export interface QueueItem {
  id: string;
  file: File;
  targetFolderId?: string;
  relativePath?: string;
  status: 'pending' | 'uploading' | 'complete' | 'error' | 'cancelled';
  progress: number;
  uploadedBytes: number;
  totalBytes: number;
  completedChunks: number;
  totalChunks: number;
  errorMessage?: string;
  serverFileId?: string;
  conflictInfo?: { type: 'file' | 'folder'; name: string; existingItemId: string };
  conflictAction?: 'overwrite' | 'rename';
}

export interface UploadContextValue {
  queue: QueueItem[];
  isUploading: boolean;
  addFiles: (files: FileList | File[], folderId?: string) => void;
  addFolder: (files: FileList | File[], folderId?: string) => Promise<void>;
  cancelItem: (id: string) => void;
  cancelAll: () => void;
  clearCompleted: () => void;
  retryItem: (id: string) => void;
  resolveConflict: (id: string, action: ConflictResolution) => Promise<void>;
  currentFolderId?: string;
  setCurrentFolderId: (id?: string) => void;
  onUploadSuccess?: () => void;
  setOnUploadSuccess: (cb: (() => void) | undefined) => void;
  setOnConflict: (cb: ((queueItem: QueueItem) => Promise<ConflictResolution>) | undefined) => void;
}
