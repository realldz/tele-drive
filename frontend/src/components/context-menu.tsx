'use client';

import { Edit2, Move, Share2, Trash2, Info, RotateCcw } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';

interface ContextMenuProps {
  x: number;
  y: number;
  itemType: 'file' | 'folder';
  onRename?: () => void;
  onMove?: () => void;
  onShare?: () => void;
  onDelete?: (e: React.MouseEvent) => void;
  onDetails?: () => void;
  /** Trash-specific actions */
  onRestore?: (e: React.MouseEvent) => void;
  onPermanentDelete?: (e: React.MouseEvent) => void;
  /** When > 1, display batch labels and hide single-item-only actions */
  selectionCount?: number;
}

export default function ContextMenu({
  x, y, itemType,
  onRename, onMove, onShare, onDelete, onDetails,
  onRestore, onPermanentDelete,
  selectionCount = 1,
}: ContextMenuProps) {
  const { t } = useI18n();
  const isBatch = selectionCount > 1;

  return (
    <div
      className="fixed bg-white border border-gray-200 rounded-xl shadow-[0_10px_40px_-10px_rgba(0,0,0,0.15)] w-52 py-2 z-50 text-sm"
      style={{
        top: Math.min(y, window.innerHeight - 300),
        left: Math.min(x, window.innerWidth - 220),
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Selection count badge when in batch mode */}
      {isBatch && (
        <div className="px-4 py-1.5 text-xs font-semibold text-blue-600 bg-blue-50 mx-2 mb-1 rounded-md text-center">
          {t('selection.count', { count: String(selectionCount) })}
        </div>
      )}

      {/* Single-item-only actions (hidden in batch mode) */}
      {!isBatch && onDetails && (
        <button
          onClick={onDetails}
          className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-gray-700 cursor-pointer transition-colors"
        >
          <Info size={16} /> {t('contextMenu.details')}
        </button>
      )}
      {!isBatch && onRename && (
        <button
          onClick={onRename}
          className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-gray-700 cursor-pointer transition-colors"
        >
          <Edit2 size={16} /> {t('contextMenu.rename')}
        </button>
      )}

      {/* Move — available for both single and batch */}
      {onMove && (
        <button
          onClick={onMove}
          className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-gray-700 cursor-pointer transition-colors"
        >
          <Move size={16} /> {isBatch ? t('selection.moveSelected') : t('contextMenu.move')}
        </button>
      )}

      {/* Share — single only */}
      {!isBatch && onShare && (
        <button
          onClick={onShare}
          className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-blue-600 font-medium cursor-pointer transition-colors"
        >
          <Share2 size={16} /> {t('contextMenu.share')}
        </button>
      )}

      {/* Delete (soft delete to trash) — available for both single and batch */}
      {onDelete && (
        <>
          <div className="border-t border-gray-100 my-1"></div>
          <button
            onClick={onDelete}
            className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-red-600 font-medium cursor-pointer transition-colors"
          >
            <Trash2 size={16} /> {isBatch ? t('selection.deleteSelected') : t('contextMenu.delete')}
          </button>
        </>
      )}

      {/* Trash-specific: Restore */}
      {onRestore && (
        <button
          onClick={onRestore}
          className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-green-600 font-medium cursor-pointer transition-colors"
        >
          <RotateCcw size={16} /> {isBatch ? t('selection.restoreSelected') : t('trash.restore')}
        </button>
      )}

      {/* Trash-specific: Permanent Delete */}
      {onPermanentDelete && (
        <>
          <div className="border-t border-gray-100 my-1"></div>
          <button
            onClick={onPermanentDelete}
            className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-red-600 font-medium cursor-pointer transition-colors"
          >
            <Trash2 size={16} /> {isBatch ? t('selection.permanentDeleteSelected') : t('trash.permanentDelete')}
          </button>
        </>
      )}
    </div>
  );
}
