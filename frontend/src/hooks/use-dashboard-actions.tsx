'use client';

import { useState, useCallback } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import {
  createFolder, deleteFolder, restoreFolder, deleteFile, restoreFile,
  abortUpload, requestDownloadToken, moveItem, formatBandwidthResetTime,
  API_URL, isConflictError, parseConflictResponse, retryBuffer,
} from '@/lib/api';
import { LOCALE_DATE_MAP, type Locale } from '@/providers/i18n-context';
import { TOAST_SHORT_MS, TOAST_LONG_MS, DOWNLOAD_CLEANUP_DELAY_MS } from '@/lib/constants';
import type { FileRecord, FolderRecord } from '@/lib/types';
import type { SelectionState } from '@/hooks/use-selection';
import type { ConflictResolution } from '@/providers/upload/upload-types';

type ItemType = 'file' | 'folder';

interface UseDashboardActionsArgs {
  t: (key: string, vars?: Record<string, string>) => string;
  locale: Locale;
  currentFolderId: string | undefined;
  fetchContent: () => void;
  selection: SelectionState;
  files: FileRecord[];
  folders: FolderRecord[];
  setFiles: React.Dispatch<React.SetStateAction<FileRecord[]>>;
  startDownload: (fileIds?: string[], folderIds?: string[], label?: string) => Promise<void>;
  buildMoveConflict: (itemId: string, itemType: ItemType, error: unknown, destinationFolderId?: string | null) => boolean;
  applyToAllRef: React.MutableRefObject<ConflictResolution | null>;
}

const toBackendAction = (action: ConflictResolution) =>
  action === 'skip' ? 'skip'
    : action === 'overwrite' ? 'overwrite'
      : action === 'keepBoth' ? 'rename'
        : 'merge';

/**
 * All dashboard mutations: create folder, soft-delete with undo, stuck-upload
 * cleanup, buffer retry, single + batch download (ZIP), batch delete and move.
 */
export function useDashboardActions({
  t, locale, currentFolderId, fetchContent, selection,
  files, folders, setFiles, startDownload, buildMoveConflict, applyToAllRef,
}: UseDashboardActionsArgs) {
  const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState<Set<string>>(new Set());
  const [createFolderError, setCreateFolderError] = useState<string | null>(null);

  const handleCreateFolder = useCallback(async (name: string): Promise<boolean> => {
    setCreateFolderError(null);
    try {
      await createFolder(name, currentFolderId);
      fetchContent();
      return true;
    } catch (error: unknown) {
      setCreateFolderError(isConflictError(error)
        ? t('createFolder.nameConflict')
        : t('dashboard.createFolderError'));
      return false;
    }
  }, [currentFolderId, fetchContent, t]);

  const deleteWithUndo = useCallback((
    id: string,
    deletedLabel: string,
    restoreFn: (id: string) => Promise<unknown>,
  ) => {
    toast.success((ti) => (
      <span className="flex items-center gap-2">
        {deletedLabel}
        <button
          onClick={async () => {
            toast.dismiss(ti.id);
            try { await restoreFn(id); fetchContent(); }
            catch { toast.error(t('dashboard.undoError')); }
          }}
          className="text-blue-500 font-semibold text-sm hover:underline ml-2 cursor-pointer"
        >
          {t('dashboard.undo')}
        </button>
      </span>
    ), { duration: TOAST_LONG_MS });
  }, [fetchContent, t]);

  const handleDeleteFolder = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await deleteFolder(id);
      fetchContent();
      deleteWithUndo(id, t('dashboard.deletedFolder'), restoreFolder);
    } catch { toast.error(t('dashboard.deleteStuckError')); }
  }, [fetchContent, t, deleteWithUndo]);

  const handleDeleteFile = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await deleteFile(id);
      fetchContent();
      deleteWithUndo(id, t('dashboard.deletedFile'), restoreFile);
    } catch { toast.error(t('dashboard.deleteStuckError')); }
  }, [fetchContent, t, deleteWithUndo]);

  const handleDeleteStuckFile = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setActionLoading(prev => new Set(prev).add(id));
    try { await abortUpload(id); fetchContent(); }
    catch { toast.error(t('dashboard.deleteStuckError')); }
    finally { setActionLoading(prev => { const next = new Set(prev); next.delete(id); return next; }); }
  }, [fetchContent, t]);

  const handleRetryBuffer = useCallback(async (id: string) => {
    try {
      await retryBuffer(id);
      setFiles(prev => prev.map(f => f.id === id ? { ...f, status: 'buffered' } : f));
      toast.success(t('upload.complete'));
    } catch {
      toast.error(t('upload.failed'));
    }
  }, [t, setFiles]);

  const handleDownload = useCallback(async (fileId: string, filename: string) => {
    setDownloadingFiles(prev => new Set(prev).add(fileId));
    toast.loading(t('dashboard.downloadStarted'), { icon: '⬇️', duration: TOAST_SHORT_MS });
    try {
      const { url } = await requestDownloadToken(fileId);
      const link = document.createElement('a');
      link.href = API_URL + url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        const resetTime = formatBandwidthResetTime(err.response.headers?.['x-bandwidth-reset'], LOCALE_DATE_MAP[locale]);
        toast.error(resetTime
          ? t('dashboard.bandwidthExceededAt', { time: resetTime })
          : t('dashboard.bandwidthExceeded'));
      } else {
        toast.error(t('dashboard.downloadError'));
      }
    } finally {
      setTimeout(() => setDownloadingFiles(prev => {
        const n = new Set(prev); n.delete(fileId); return n;
      }), DOWNLOAD_CLEANUP_DELAY_MS);
    }
  }, [locale, t]);

  const handleBatchDownload = useCallback(async () => {
    const ids = Array.from(selection.selectedIds);
    const selectedFileIds = ids.filter(id => files.some(f => f.id === id));
    const selectedFolderIds = ids.filter(id => folders.some(f => f.id === id));

    if (selectedFileIds.length === 1 && selectedFolderIds.length === 0) {
      const file = files.find(f => f.id === selectedFileIds[0])!;
      return handleDownload(file.id, file.filename);
    }

    const label = selectedFolderIds.length === 1 && selectedFileIds.length === 0
      ? folders.find(f => f.id === selectedFolderIds[0])?.name || 'download'
      : `${ids.length} items`;

    try {
      await startDownload(
        selectedFileIds.length > 0 ? selectedFileIds : undefined,
        selectedFolderIds.length > 0 ? selectedFolderIds : undefined,
        label,
      );
      selection.clearSelection();
      toast.success(t('downloadZip.preparing'));
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        if (err.response?.status === 409) { toast.error(t('downloadZip.activeJob')); return; }
        if (err.response?.status === 429) {
          const resetTime = formatBandwidthResetTime(err.response.headers?.['x-bandwidth-reset'], LOCALE_DATE_MAP[locale]);
          toast.error(resetTime
            ? t('dashboard.bandwidthExceededAt', { time: resetTime })
            : t('downloadZip.bandwidthExceeded'));
          return;
        }
      }
      toast.error(t('downloadZip.failed'));
    }
  }, [selection, files, folders, startDownload, handleDownload, t, locale]);

  const handleBatchDelete = useCallback(async () => {
    const ids = Array.from(selection.selectedIds);
    for (const id of ids) {
      const isFolder = folders.some(f => f.id === id);
      try {
        if (isFolder) await deleteFolder(id);
        else await deleteFile(id);
      } catch { toast.error(t('dashboard.deleteStuckError')); }
    }
    selection.clearSelection();
    fetchContent();
    toast.success(t('dashboard.deletedFile'));
  }, [selection, folders, fetchContent, t]);

  const handleBatchMoveConfirm = useCallback(async (destFolderId: string | null) => {
    const ids = Array.from(selection.selectedIds);
    for (const id of ids) {
      const isFolder = folders.some(f => f.id === id);
      const type: ItemType = isFolder ? 'folder' : 'file';

      const applyStored = applyToAllRef.current;
      if (applyStored) {
        try {
          await moveItem(type, id, destFolderId, toBackendAction(applyStored));
        } catch (error: unknown) {
          if (!isConflictError(error)) toast.error(t('dashboard.moveError'));
        }
        continue;
      }

      try {
        await moveItem(type, id, destFolderId);
      } catch (error: unknown) {
        if (isConflictError(error)) {
          const conflict = parseConflictResponse(error);
          if (!conflict) continue;
          buildMoveConflict(id, type, error, destFolderId);
          return;
        }
        toast.error(t('dashboard.moveError'));
      }
    }

    selection.clearSelection();
    fetchContent();
  }, [selection, folders, fetchContent, t, buildMoveConflict, applyToAllRef]);

  return {
    downloadingFiles, actionLoading,
    createFolderError, setCreateFolderError,
    handleCreateFolder,
    handleDeleteFolder, handleDeleteFile, handleDeleteStuckFile,
    handleRetryBuffer,
    handleDownload, handleBatchDownload,
    handleBatchDelete, handleBatchMoveConfirm,
  };
}
