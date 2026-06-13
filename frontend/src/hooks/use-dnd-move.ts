'use client';

import { useState, useCallback } from 'react';
import { moveItem, isConflictError } from '@/lib/api';
import type { FileRecord, FolderRecord } from '@/lib/types';

type ItemType = 'file' | 'folder';

interface DraggedItem {
  id: string;
  type: ItemType;
}

interface UseDndMoveArgs {
  currentFolderId: string | undefined;
  fetchContent: () => void;
  /** Build a move-conflict descriptor; returns true if a conflict was handled. */
  buildMoveConflict: (itemId: string, itemType: ItemType, error: unknown, destinationFolderId?: string | null) => boolean;
  onMoveError: () => void;
}

/**
 * Drag-and-drop move handlers for the dashboard. Tracks the dragged item and
 * the folder currently hovered, and issues a move on drop (delegating conflicts
 * to buildMoveConflict).
 */
export function useDndMove({ currentFolderId, fetchContent, buildMoveConflict, onMoveError }: UseDndMoveArgs) {
  const [draggedItem, setDraggedItem] = useState<DraggedItem | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, item: FileRecord | FolderRecord, type: ItemType) => {
    setDraggedItem({ id: item.id, type });
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, folderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (draggedItem && draggedItem.id !== folderId) setDragOverFolderId(folderId);
  }, [draggedItem]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolderId(null);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, targetFolderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolderId(null);
    if (!draggedItem || targetFolderId === (currentFolderId || null) || draggedItem.id === targetFolderId) return;

    try {
      await moveItem(draggedItem.type, draggedItem.id, targetFolderId);
      fetchContent();
    } catch (error: unknown) {
      if (isConflictError(error)) {
        buildMoveConflict(draggedItem.id, draggedItem.type, error, targetFolderId);
      } else {
        onMoveError();
      }
    }
    setDraggedItem(null);
  }, [draggedItem, currentFolderId, fetchContent, buildMoveConflict, onMoveError]);

  return {
    draggedItem,
    dragOverFolderId,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
