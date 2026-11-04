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
    <div className="fixed inset-x-3 bottom-3 z-50 animate-in slide-in-from-bottom-4 fade-in duration-200 md:bottom-6">
      <div
        className="mx-auto grid w-full max-w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border border-gray-700 bg-gray-900 px-3 py-3 text-white shadow-2xl md:flex md:w-fit md:px-5"
      >
        <span className="text-sm font-medium whitespace-nowrap">
          {t('selection.count', { count: String(selectedCount) })}
        </span>
        <div className="hidden h-5 w-px bg-gray-600 md:block" />

        <div
          className={`col-span-2 row-start-2 grid w-full min-w-0 gap-2 ${variant === 'shared' ? 'grid-cols-1' : 'grid-cols-2'} md:flex md:w-auto md:flex-1 md:flex-wrap`}
        >
          {variant === 'dashboard' && (
            <>
              {onMove && (
                <button type="button" onClick={onMove} disabled={disabled} className="flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-gray-700 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50 md:w-auto">
                  <Move size={15} /> {t('selection.moveSelected')}
                </button>
              )}
              {onDownload && (
                <button type="button" onClick={onDownload} disabled={disabled} className="flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 md:w-auto">
                  <Download size={15} /> {t('selection.downloadSelected')}
                </button>
              )}
              {onDelete && (
                <button type="button" onClick={onDelete} disabled={disabled} className="flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50 md:w-auto">
                  <Trash2 size={15} /> {t('selection.deleteSelected')}
                </button>
              )}
            </>
          )}

          {variant === 'shared' && onDownload && (
            <button type="button" onClick={onDownload} disabled={disabled} className="flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 md:w-auto">
              <Download size={15} /> {t('selection.downloadSelected')}
            </button>
          )}

          {variant === 'trash' && (
            <>
              {onRestore && (
                <button type="button" onClick={onRestore} disabled={disabled} className="flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50 md:w-auto">
                  <RotateCcw size={15} /> {t('selection.restoreSelected')}
                </button>
              )}
              {onPermanentDelete && (
                <button type="button" onClick={onPermanentDelete} disabled={disabled} className="flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50 md:w-auto">
                  <Trash2 size={15} /> {t('selection.permanentDeleteSelected')}
                </button>
              )}
            </>
          )}
        </div>

        <div className="hidden h-5 w-px bg-gray-600 md:block" />
        <button
          type="button"
          disabled={disabled}
          onClick={onClear}
          className="col-start-2 row-start-1 flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-gray-300 transition-colors hover:bg-gray-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          title={t('selection.deselectAll')}
          aria-label={t('selection.deselectAll')}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
