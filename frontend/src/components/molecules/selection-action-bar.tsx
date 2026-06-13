'use client';

import { Trash2, Move, RotateCcw, X, Download } from 'lucide-react';
import { useI18n } from '@/providers/i18n-context';

interface SelectionActionBarProps {
  selectedCount: number;
  onClear: () => void;
  variant?: 'dashboard' | 'trash' | 'shared';
  onDelete?: () => void;
  onMove?: () => void;
  onDownload?: () => void;
  onRestore?: () => void;
  onPermanentDelete?: () => void;
  disabled?: boolean;
}

export default function SelectionActionBar({
  selectedCount, onClear, variant = 'dashboard',
  onDelete, onMove, onDownload, onRestore, onPermanentDelete, disabled = false,
}: SelectionActionBarProps) {
  const { t } = useI18n();
  if (selectedCount === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 fade-in duration-200">
      <div className="flex items-center gap-3 bg-gray-900 text-white px-5 py-3 rounded-2xl shadow-2xl border border-gray-700">
        <span className="text-sm font-medium whitespace-nowrap">
          {t('selection.count', { count: String(selectedCount) })}
        </span>
        <div className="w-px h-5 bg-gray-600" />

        {variant === 'dashboard' && (
          <>
            {onMove && (
              <button onClick={onMove} disabled={disabled} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-gray-700 hover:bg-gray-600 disabled:opacity-50 rounded-lg transition-colors cursor-pointer">
                <Move size={15} /> {t('selection.moveSelected')}
              </button>
            )}
            {onDownload && (
              <button onClick={onDownload} disabled={disabled} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors cursor-pointer">
                <Download size={15} /> {t('selection.downloadSelected')}
              </button>
            )}
            {onDelete && (
              <button onClick={onDelete} disabled={disabled} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded-lg transition-colors cursor-pointer">
                <Trash2 size={15} /> {t('selection.deleteSelected')}
              </button>
            )}
          </>
        )}

        {variant === 'shared' && onDownload && (
          <button onClick={onDownload} disabled={disabled} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors cursor-pointer">
            <Download size={15} /> {t('selection.downloadSelected')}
          </button>
        )}

        {variant === 'trash' && (
          <>
            {onRestore && (
              <button onClick={onRestore} disabled={disabled} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-green-600 hover:bg-green-500 disabled:opacity-50 rounded-lg transition-colors cursor-pointer">
                <RotateCcw size={15} /> {t('selection.restoreSelected')}
              </button>
            )}
            {onPermanentDelete && (
              <button onClick={onPermanentDelete} disabled={disabled} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded-lg transition-colors cursor-pointer">
                <Trash2 size={15} /> {t('selection.permanentDeleteSelected')}
              </button>
            )}
          </>
        )}

        <div className="w-px h-5 bg-gray-600" />
        <button onClick={onClear} className="flex items-center gap-1 px-2 py-1.5 text-sm text-gray-300 hover:text-white hover:bg-gray-700 rounded-lg transition-colors cursor-pointer" title={t('selection.deselectAll')}>
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
