'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Captions, FolderOpen, Upload, X } from 'lucide-react';
import { useAuth } from '@/providers/auth-context';
import { useI18n } from '@/providers/i18n-context';
import { useVideoSubtitles } from '@/hooks/use-video-subtitles';
import SubtitleDrivePicker from '@/components/organisms/preview/subtitle-drive-picker';

type Props = ReturnType<typeof useVideoSubtitles> & { controlHost: HTMLElement | null };

export default function VideoSubtitleControls({ subtitle, enabled, setEnabled, loading, error, load, controlHost }: Props) {
  const { t } = useI18n();
  const { token, user } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const panelId = useId();
  const buttonClass = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-50';
  const closeMenu = () => { setMenuOpen(false); buttonRef.current?.focus(); };

  useEffect(() => {
    if (menuOpen && !pickerOpen) panelRef.current?.focus();
  }, [menuOpen, pickerOpen]);

  return (
    <>
      {controlHost && createPortal(
        <button
          ref={buttonRef}
          type="button"
          aria-label={t('subtitles.label')}
          title={t('subtitles.label')}
          aria-haspopup="dialog"
          aria-expanded={menuOpen || pickerOpen}
          aria-controls={panelId}
          onClick={event => { event.stopPropagation(); setMenuOpen(value => !value); }}
          onPointerDown={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
          onKeyUp={event => event.stopPropagation()}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, padding: 4, border: 0, borderRadius: 4, cursor: 'pointer', background: 'transparent', color: error ? '#fca5a5' : subtitle && enabled ? '#60a5fa' : '#fff' }}
        >
          <Captions aria-hidden="true" size={24} />
        </button>, controlHost,
      )}
      <input ref={inputRef} type="file" accept=".srt,.vtt" className="hidden" aria-label={t('subtitles.local')} onChange={e => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = '';
        if (file) void load(file);
      }} />
      {menuOpen && !pickerOpen && <div
        className="absolute inset-0 z-40"
        onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) closeMenu(); }}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Escape') { event.preventDefault(); closeMenu(); }
          if (event.key === 'Tab') {
            const buttons = panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
            if (!buttons?.length) return;
            const first = buttons[0], last = buttons[buttons.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
              event.preventDefault(); last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault(); first.focus();
            }
          }
        }}
        onKeyUp={event => event.stopPropagation()}
      >
        <div ref={panelRef} id={panelId} role="dialog" aria-modal="true" aria-label={t('subtitles.label')} tabIndex={-1}
          className="absolute bottom-14 right-2 max-h-[calc(100%-4rem)] w-72 max-w-[calc(100%-1rem)] overflow-y-auto rounded-xl border border-white/15 bg-gray-950/95 p-2 text-white shadow-xl outline-none">
          <div className="mb-1 flex items-center justify-between px-3 py-1">
            <span className="text-sm font-semibold">{t('subtitles.label')}</span>
            <button type="button" onClick={closeMenu} aria-label={t('subtitles.close')} className="rounded p-1 hover:bg-white/10"><X size={16} /></button>
          </div>
          <button type="button" className={buttonClass} onClick={() => inputRef.current?.click()}>
            <Upload size={16} aria-hidden="true" />{t('subtitles.local')}
          </button>
          <button type="button" className={buttonClass} disabled={!token || !user} onClick={() => setPickerOpen(true)}>
            <FolderOpen size={16} aria-hidden="true" />{t('subtitles.drive')}
          </button>
          {(!token || !user) && <p className="px-3 py-1 text-xs text-gray-400">{t('subtitles.loginRequired')}</p>}
          {subtitle && <div className="mt-2 border-t border-white/10 pt-2">
            <p className="truncate px-3 py-1 text-xs text-gray-400" title={subtitle.name}>{subtitle.name}</p>
            <button type="button" className={buttonClass} aria-pressed={enabled} onClick={() => setEnabled(!enabled)}>
              <Captions size={16} aria-hidden="true" />{t(enabled ? 'subtitles.turnOff' : 'subtitles.turnOn')}
            </button>
          </div>}
          {loading && <p role="status" className="px-3 py-2 text-xs text-gray-300">{t('subtitles.loading')}</p>}
          {error && <p role="alert" className="px-3 py-2 text-xs text-red-300">{t(`subtitles.${error}`)}</p>}
        </div>
      </div>}
      {pickerOpen && token && user && <SubtitleDrivePicker
        key={user.id}
        onClose={() => setPickerOpen(false)}
        onSelect={file => { setPickerOpen(false); void load(file); }}
      />}
    </>
  );
}
