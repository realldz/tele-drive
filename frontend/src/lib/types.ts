export interface FolderRecord {
  id: string;
  name: string;
  parentId: string | null;
  userId: string;
  visibility: string;
  shareToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileRecord {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  status: string;
  totalChunks: number;
  folderId: string | null;
  userId: string;
  visibility: string;
  shareToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BreadcrumbItem {
  id: string;
  name: string;
}

/** Trashed items include deletedAt */
export interface TrashedFolder extends FolderRecord {
  deletedAt: string;
}

export interface TrashedFile extends FileRecord {
  deletedAt: string;
}

/** Shared file info from /files/share/:token */
export interface SharedFileInfo {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  createdAt: string;
  user?: { username: string };
}

/** Shared folder root from /folders/share/:token */
export interface SharedFolderRoot {
  id: string;
  name: string;
  user?: { username: string };
}
