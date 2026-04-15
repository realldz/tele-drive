export interface PaginatedFolderContent {
  folders: unknown[];
  files: unknown[];
  nextFolderCursor: string | null;
  nextFileCursor: string | null;
  totalFolders: number;
  totalFiles: number;
}
