'use client';

import { useState, useRef, useEffect } from 'react';
import { Globe } from 'lucide-react';
import { useI18n, LOCALE_LABELS, type Locale } from '@/components/i18n-context';

const locales: Locale[] = ['vi', 'en', 'zh', 'ja'];

export default function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition-colors hover:bg-white/5 text-slate-300"
      >
        <Globe size={16} className="flex-shrink-0" />
        <span className="truncate">{LOCALE_LABELS[locale]}</span>
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-1 w-full bg-slate-800 border border-slate-700 rounded-lg shadow-xl overflow-hidden z-50">
          {locales.map((l) => (
            <button
              key={l}
              onClick={() => { setLocale(l); setIsOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                l === locale
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-300 hover:bg-slate-700'
              }`}
            >
              {LOCALE_LABELS[l]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
