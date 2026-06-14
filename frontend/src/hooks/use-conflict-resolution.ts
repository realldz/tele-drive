'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import { moveItem, isConflictError, parseConflictResponse } from '@/lib/api';
import type { ConflictInfo } from '@/lib/api';
import type { ConflictResolution, QueueItem } from '@/providers/upload/upload-types';
import type { FileRecord, FolderRecord } from '@/lib/types';

export interface PendingConflict {
  type: 'upload' | 'move';
  itemId: string;
  conflictInfo: ConflictInfo;
  destinationFolderId?: string | null;
  existingItemName?: string;
  existingItemSize?: number;
  existingItemDate?: string;
  incomingSize?: number;
  incomingDate?: string;
}

interface UseConflictResolutionArgs {
  folders: FolderRecord[];
  files: FileRecord[];
  fetchContent: () => void;
  resolveConflict: (id: string, action: ConflictResolution) => Promise<void>;
  queue: QueueItem[];
  t: (key: string, vars?: Record<string, string>) => string;
}

const toBackendAction = (action: ConflictResolution) =>
  action === 'skip' ? 'skip'
    : action === 'overwrite' ? 'overwrite'
      : action === 'keepBoth' ? 'rename'
        : 'merge';

/**
 * Conflict state machine shared by upload, drag/drop move, and batch move.
 * Holds the pending conflict, the "apply to all" choice, and resolves both
 * move conflicts (re-issues moveItem with a chosen action) and upload
 * conflicts (delegates to the upload provider).
 */
export function useConflictResolution({
  folders, files, fetchContent, resolveConflict, queue, t,
}: UseConflictResolutionArgs) {
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const applyToAllRef = useRef<ConflictResolution | null>(null);

  // Watch the upload queue for items flagged as conflicts
  useEffect(() => {
    const conflictItem = queue.find(item => item.errorMessage === 'conflict');
    if (conflictItem && !pendingConflict) {
      // If the user already chose "apply to all", auto-resolve every subsequent
      // upload conflict with that action instead of re-opening the modal.
      if (applyToAllRef.current) {
        void resolveConflict(conflictItem.id, applyToAllRef.current);
        return;
      }
      const fileInfo = conflictItem.conflictInfo;
      if (fileInfo) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from the upload queue (external provider state)
        setPendingConflict({
          type: 'upload',
          itemId: conflictItem.id,
          conflictInfo: {
            type: 'file',
            id: fileInfo.existingItemId,
            name: fileInfo.name,
            suggestedName: '',
            existingItemId: fileInfo.existingItemId,
          },
          existingItemName: fileInfo.name,
          incomingSize: conflictItem.totalBytes,
          incomingDate: new Date().toISOString(),
        });
      }
    }
  }, [queue, pendingConflict, applyToAllRef, resolveConflict]);

  /** Build a move-conflict descriptor from an error + the items involved. */
  const buildMoveConflict = useCallback((
    itemId: string,
    itemType: 'file' | 'folder',
    error: unknown,
    destinationFolderId?: string | null,
  ): boolean => {
    const conflict = parseConflictResponse(error);
    if (!conflict) return false;
    const existingItem = itemType === 'folder'
      ? folders.find(f => f.id === conflict.existingItemId)
      : files.find(f => f.id === conflict.existingItemId);
    const movingItem = itemType === 'folder'
      ? folders.find(f => f.id === itemId)
      : files.find(f => f.id === itemId);

    setPendingConflict({
      type: 'move',
      itemId,
      conflictInfo: conflict,
      destinationFolderId,
      existingItemName: itemType === 'folder' && existingItem
        ? (existingItem as FolderRecord).name
        : itemType === 'file' && existingItem
          ? (existingItem as FileRecord).filename
          : conflict.name,
      existingItemDate: existingItem?.updatedAt,
      incomingSize: itemType === 'file' && movingItem ? (movingItem as FileRecord).size : undefined,
      incomingDate: movingItem?.updatedAt,
    });
    return true;
  }, [folders, files]);

  const handleConflictResolution = useCallback(async (action: ConflictResolution, applyToAll: boolean) => {
    if (!pendingConflict) return;
    const { type, itemId, destinationFolderId } = pendingConflict;

    if (applyToAll) applyToAllRef.current = action;

    if (type === 'move') {
      const backendAction = toBackendAction(action);
      try {
        const itemType = folders.some(f => f.id === itemId) ? 'folder' : 'file';
        await moveItem(itemType, itemId, destinationFolderId ?? null, backendAction);
        if (action !== 'skip') {
          toast.success(
            action === 'overwrite' ? t('conflict.overwriteSuccess')
              : action === 'keepBoth' ? t('conflict.renamed')
                : t('conflict.merged'),
          );
        } else {
          toast.success(t('conflict.skipped'));
        }
        fetchContent();
      } catch (error: unknown) {
        if (!isConflictError(error)) toast.error(t('dashboard.moveError'));
      }
    } else if (type === 'upload') {
      await resolveConflict(itemId, action);
    }

    setPendingConflict(null);
  }, [pendingConflict, folders, fetchContent, resolveConflict, t]);

  return {
    pendingConflict,
    setPendingConflict,
    applyToAllRef,
    buildMoveConflict,
    handleConflictResolution,
  };
}
