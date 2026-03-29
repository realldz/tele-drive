'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

export interface DragSelectRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UseDragSelectOptions {
  /** Ref to the scrollable container */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Callback when items are selected by drag */
  onSelect: (ids: string[]) => void;
  /** Whether drag select is enabled */
  enabled?: boolean;
}

/**
 * Hook for rubber-band / lasso drag-to-select.
 *
 * Items must have `data-selectable-id="<id>"` attribute.
 * Mousedown on empty space starts the drag; items intersecting
 * the drawn rectangle are selected on mouseup.
 */
export function useDragSelect({ containerRef, onSelect, enabled = true }: UseDragSelectOptions) {
  const [isDragging, setIsDragging] = useState(false);
  const [rect, setRect] = useState<DragSelectRect | null>(null);

  const startPointRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const frameRef = useRef<number>(0);

  const getContainerOffset = useCallback(() => {
    if (!containerRef.current) return { left: 0, top: 0, scrollLeft: 0, scrollTop: 0 };
    const bounds = containerRef.current.getBoundingClientRect();
    return {
      left: bounds.left,
      top: bounds.top,
      scrollLeft: containerRef.current.scrollLeft,
      scrollTop: containerRef.current.scrollTop,
    };
  }, [containerRef]);

  /** Get IDs of all selectable items intersecting the given rect */
  const getIntersectingIds = useCallback((selRect: DragSelectRect): string[] => {
    if (!containerRef.current) return [];
    const items = containerRef.current.querySelectorAll('[data-selectable-id]');
    const containerBounds = containerRef.current.getBoundingClientRect();
    const ids: string[] = [];

    // Selection rect is in container-relative coords (including scroll)
    // Convert to viewport coords for comparison
    const selLeft = selRect.x + containerBounds.left - containerRef.current.scrollLeft;
    const selTop = selRect.y + containerBounds.top - containerRef.current.scrollTop;
    const selRight = selLeft + selRect.width;
    const selBottom = selTop + selRect.height;

    items.forEach((el) => {
      const elRect = el.getBoundingClientRect();
      // Check intersection
      if (
        elRect.left < selRight &&
        elRect.right > selLeft &&
        elRect.top < selBottom &&
        elRect.bottom > selTop
      ) {
        const id = el.getAttribute('data-selectable-id');
        if (id) ids.push(id);
      }
    });

    return ids;
  }, [containerRef]);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    const handleMouseDown = (e: MouseEvent) => {
      // Only start on left button, not on interactive elements
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;

      // Don't start drag on buttons, inputs, links, or selectable items themselves
      if (target.closest('button, input, a, [data-selectable-id], [data-no-drag-select]')) return;

      const offset = getContainerOffset();
      const x = e.clientX - offset.left + container.scrollLeft;
      const y = e.clientY - offset.top + container.scrollTop;

      startPointRef.current = { x, y };
      isDraggingRef.current = false;
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!startPointRef.current) return;

      const offset = getContainerOffset();
      const currentX = e.clientX - offset.left + container.scrollLeft;
      const currentY = e.clientY - offset.top + container.scrollTop;

      const dx = Math.abs(currentX - startPointRef.current.x);
      const dy = Math.abs(currentY - startPointRef.current.y);

      // Minimum drag distance threshold to avoid accidental drags
      if (!isDraggingRef.current && dx < 5 && dy < 5) return;

      if (!isDraggingRef.current) {
        isDraggingRef.current = true;
        setIsDragging(true);
      }

      // Cancel any pending frame
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => {
        const newRect: DragSelectRect = {
          x: Math.min(startPointRef.current!.x, currentX),
          y: Math.min(startPointRef.current!.y, currentY),
          width: dx,
          height: dy,
        };
        setRect(newRect);

        // Live-update selection as user drags
        const ids = getIntersectingIds(newRect);
        onSelect(ids);
      });
    };

    const handleMouseUp = () => {
      if (isDraggingRef.current && rect) {
        const ids = getIntersectingIds(rect);
        onSelect(ids);
      }
      startPointRef.current = null;
      isDraggingRef.current = false;
      setIsDragging(false);
      setRect(null);
      cancelAnimationFrame(frameRef.current);
    };

    container.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      cancelAnimationFrame(frameRef.current);
    };
  }, [enabled, containerRef, getContainerOffset, getIntersectingIds, onSelect, rect]);

  return { isDragging, rect };
}

/** Render the selection rectangle overlay */
export function DragSelectOverlay({ rect }: { rect: DragSelectRect | null }) {
  if (!rect) return null;
  return (
    <div
      className="absolute pointer-events-none border-2 border-blue-500 bg-blue-500/10 rounded-sm z-40"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
      }}
    />
  );
}
