import type { FileRecord, FolderRecord } from '@/lib/types';

export type SortField = 'name' | 'createdAt';
export type SortDirection = 'asc' | 'desc';

/** Shared props for grid + list dashboard views (item data + interaction handlers). */
export interface DashboardViewProps {
  visibleFolders: FolderRecord[];
  visibleFiles: FileRecord[];
  selection: { isSelected: (id: string) => boolean };
  downloadingFiles: Set<string>;
  actionLoading: Set<string>;
  dragOverFolderId: string | null;
  onItemClick: (e: React.MouseEvent, item: FileRecord | FolderRecord, type: 'file' | 'folder') => void;
  onDragStart: (e: React.DragEvent, item: FileRecord | FolderRecord, type: 'file' | 'folder') => void;
  onDragOver: (e: React.DragEvent, folderId: string | null) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, targetFolderId: string | null) => void;
  onContextMenu: (e: React.MouseEvent, item: FileRecord | FolderRecord, type: 'file' | 'folder') => void;
  onDownload: (fileId: string, filename: string) => void;
  onDeleteStuckFile: (e: React.MouseEvent, id: string) => void;
  onRetryBuffer: (id: string) => void;
}
