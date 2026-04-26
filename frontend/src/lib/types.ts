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

export type UserRole = 'ADMIN' | 'USER';

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
}

export interface AdminUser extends AuthUser {
  id: string;
  username: string;
  role: UserRole;
  quota: string;
  usedSpace: string;
  dailyBandwidthLimit: string | null;
  dailyBandwidthUsed: string;
  createdAt: string;
}

export interface AdminSetting {
  key: string;
  value: string;
}

export interface AdminUserFile {
  id: string;
  filename: string;
  size: string;
  mimeType: string;
  createdAt: string;
  isEncrypted: boolean;
}

export interface AdminLogFile {
  name: string;
  kind: 'combined' | 'error' | 'unknown';
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

export interface ReadAdminLogsResponse {
  file: string;
  compressed: boolean;
  entries: AdminLogEntry[];
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
