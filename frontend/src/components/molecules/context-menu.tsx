'use client';

import { Edit2, Move, Share2, Trash2, Info, RotateCcw, Download } from 'lucide-react';
import { useI18n } from '@/providers/i18n-context';

interface ContextMenuProps {
  x: number;
  y: number;
  itemType: 'file' | 'folder';
  onRename?: () => void;
  onMove?: () => void;
  onShare?: () => void;
  onDelete?: (e: React.MouseEvent) => void;
  onDownload?: () => void;
  onDetails?: () => void;
  onRestore?: (e: React.MouseEvent) => void;
  onPermanentDelete?: (e: React.MouseEvent) => void;
  selectionCount?: number;
}

export default function ContextMenu({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  x, y, itemType: _itemType,
  onRename, onMove, onShare, onDelete, onDownload, onDetails,
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
      {isBatch && (
        <div className="px-4 py-1.5 text-xs font-semibold text-blue-600 bg-blue-50 mx-2 mb-1 rounded-md text-center">
          {t('selection.count', { count: String(selectionCount) })}
        </div>
      )}

      {!isBatch && onDetails && (
        <button onClick={onDetails} className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-gray-700 cursor-pointer transition-colors">
          <Info size={16} /> {t('contextMenu.details')}
        </button>
      )}
      {!isBatch && onRename && (
        <button onClick={onRename} className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-gray-700 cursor-pointer transition-colors">
          <Edit2 size={16} /> {t('contextMenu.rename')}
        </button>
      )}
      {onDownload && (
        <button onClick={onDownload} className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-gray-700 cursor-pointer transition-colors">
          <Download size={16} /> {isBatch ? t('selection.downloadSelected') : t('contextMenu.download')}
        </button>
      )}
      {onMove && (
        <button onClick={onMove} className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-gray-700 cursor-pointer transition-colors">
          <Move size={16} /> {isBatch ? t('selection.moveSelected') : t('contextMenu.move')}
        </button>
      )}
      {!isBatch && onShare && (
        <button onClick={onShare} className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-blue-600 font-medium cursor-pointer transition-colors">
          <Share2 size={16} /> {t('contextMenu.share')}
        </button>
      )}
      {onDelete && (
        <>
          <div className="border-t border-gray-100 my-1" />
          <button onClick={onDelete} className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-red-600 font-medium cursor-pointer transition-colors">
            <Trash2 size={16} /> {isBatch ? t('selection.deleteSelected') : t('contextMenu.delete')}
          </button>
        </>
      )}
      {onRestore && (
        <button onClick={onRestore} className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-green-600 font-medium cursor-pointer transition-colors">
          <RotateCcw size={16} /> {isBatch ? t('selection.restoreSelected') : t('trash.restore')}
        </button>
      )}
      {onPermanentDelete && (
        <>
          <div className="border-t border-gray-100 my-1" />
          <button onClick={onPermanentDelete} className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-red-600 font-medium cursor-pointer transition-colors">
            <Trash2 size={16} /> {isBatch ? t('selection.permanentDeleteSelected') : t('trash.permanentDelete')}
          </button>
        </>
      )}
    </div>
  );
}
