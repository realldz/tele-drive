'use client';

import { useState, useCallback, useRef } from 'react';

export interface SelectionState {
  /** Set of currently selected item IDs */
  selectedIds: Set<string>;
  /** Number of selected items */
  selectedCount: number;
  /** Check if a specific item is selected */
  isSelected: (id: string) => boolean;
  /** Handle click on an item — supports Ctrl+click (toggle) and Shift+click (range) */
  handleSelect: (id: string, e: React.MouseEvent, orderedIds: string[]) => void;
  /** Clear all selections */
  clearSelection: () => void;
  /** Select all provided IDs */
  selectAll: (ids: string[]) => void;
}

/**
 * Reusable multi-select hook for files & folders.
 *
 * Supports:
 * - Click = select single (deselects others)
 * - Ctrl/Cmd + Click = toggle item in selection
 * - Shift + Click = range select from last clicked
 */
export function useSelection(): SelectionState {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedIndexRef = useRef<number>(-1);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  const handleSelect = useCallback(
    (id: string, e: React.MouseEvent, orderedIds: string[]) => {
      e.stopPropagation();

      const currentIndex = orderedIds.indexOf(id);
      if (currentIndex === -1) return;

      if (e.shiftKey && lastClickedIndexRef.current >= 0) {
        // Shift+click: range select between last clicked and current
        const start = Math.min(lastClickedIndexRef.current, currentIndex);
        const end = Math.max(lastClickedIndexRef.current, currentIndex);
        const rangeIds = orderedIds.slice(start, end + 1);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const rid of rangeIds) next.add(rid);
          return next;
        });
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+click: toggle single item
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
        lastClickedIndexRef.current = currentIndex;
      } else {
        // Plain click: select only this item
        setSelectedIds(new Set([id]));
        lastClickedIndexRef.current = currentIndex;
      }
    },
    [],
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    lastClickedIndexRef.current = -1;
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids));
  }, []);

  return {
    selectedIds,
    selectedCount: selectedIds.size,
    isSelected,
    handleSelect,
    clearSelection,
    selectAll,
  };
}
