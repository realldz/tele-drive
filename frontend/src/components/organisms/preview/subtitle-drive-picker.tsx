'use client';

import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { Loader2, X } from 'lucide-react';
import { useSubtitleDriveFiles, type SubtitleExtension } from '@/hooks/use-subtitle-drive-files';
import { formatBytes } from '@/lib/api';
import { SUBTITLE_MAX_BYTES } from '@/lib/constants';
import type { FileRecord } from '@/lib/types';
import { useI18n } from '@/providers/i18n-context';

interface SubtitleDrivePickerProps {
  onSelect: (file: FileRecord) => void;
  onClose: () => void;
  busy?: boolean;
}

export function SubtitleDrivePicker({ onSelect, onClose, busy = false }: SubtitleDrivePickerProps) {
  const { t } = useI18n();
  const search = useSubtitleDriveFiles();
  const titleId = useId();
  const searchId = useId();
  const extensionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Keep player shortcuts and the outer preview's Escape listener out of this dialog.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
    );
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-4"
      onClick={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={handleKeyDown}
      onKeyUp={event => event.stopPropagation()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg bg-white text-gray-900 shadow-xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 px-3 py-2">
          <h2 id={titleId} className="text-sm font-semibold">{t('subtitles.driveTitle')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('subtitles.close')}
            className="rounded p-2 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto p-3">
          <div className="mb-3 flex flex-wrap gap-2">
            <div className="min-w-0 flex-1 basis-40">
              <label htmlFor={searchId} className="mb-1 block text-xs font-medium">{t('subtitles.search')}</label>
              <input
                ref={inputRef}
                id={searchId}
                type="search"
                value={search.query}
                onChange={event => search.changeQuery(event.target.value)}
                placeholder={t('subtitles.searchPlaceholder')}
                className="w-full rounded border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor={extensionId} className="mb-1 block text-xs font-medium">{t('subtitles.format')}</label>
              <select
                id={extensionId}
                value={search.extension}
                onChange={event => search.changeExtension(event.target.value as SubtitleExtension)}
                className="rounded border border-gray-300 bg-white px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
              >
                <option value="srt">.srt</option>
                <option value="vtt">.vtt</option>
              </select>
            </div>
          </div>
          <ul className="space-y-1" aria-busy={search.loading}>
            {search.files.map(file => {
              const tooLarge = Number(file.size) > SUBTITLE_MAX_BYTES;
              const incomplete = file.status !== 'complete' && file.status !== 'buffered';
              const reason = tooLarge ? t('subtitles.tooLarge') : incomplete ? t('subtitles.incomplete') : null;
              return (
                <li key={file.id}>
                  <button
                    type="button"
                    disabled={busy || !!reason}
                    onClick={() => onSelect(file)}
                    className="flex w-full flex-col gap-1 rounded px-3 py-2 text-left hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="w-full break-all text-sm font-medium">{file.filename}</span>
                    <span className="text-xs text-gray-600">{formatBytes(file.size)}{reason ? ` · ${reason}` : ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div role="status" aria-live="polite" className="text-center text-sm text-gray-600">
            {(search.loading || busy) && (
              <p className="flex items-center justify-center gap-2 py-3">
                <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                {t('subtitles.loading')}
              </p>
            )}
            {!search.loading && !search.error && search.files.length === 0 && (
              <p className="py-3">{t('subtitles.noResults')}</p>
            )}
          </div>
          {search.error && (
            <div role="alert" className="py-2 text-center text-sm text-red-700">
              <p>{t('subtitles.searchError')}</p>
              <button type="button" onClick={search.retry} disabled={busy || search.loading} className="mt-1 rounded px-3 py-2 underline disabled:opacity-50">
                {t('subtitles.retry')}
              </button>
            </div>
          )}
          {search.hasMore && !search.error && (
            <button
              type="button"
              onClick={search.loadMore}
              disabled={busy || search.loading}
              className="mt-3 w-full rounded border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
            >
              {t('subtitles.loadMore')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default SubtitleDrivePicker;
