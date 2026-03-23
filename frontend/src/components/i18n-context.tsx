'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

import vi from '@/locales/vi.json';
import en from '@/locales/en.json';
import zh from '@/locales/zh.json';
import ja from '@/locales/ja.json';

export type Locale = 'vi' | 'en' | 'zh' | 'ja';

const translations: Record<Locale, Record<string, string>> = { vi, en, zh, ja };

export const LOCALE_LABELS: Record<Locale, string> = {
  vi: 'Tiếng Việt',
  en: 'English',
  zh: '中文',
  ja: '日本語',
};

export const LOCALE_DATE_MAP: Record<Locale, string> = {
  vi: 'vi-VN',
  en: 'en-US',
  zh: 'zh-CN',
  ja: 'ja-JP',
};

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const SUPPORTED_LOCALES = Object.keys(translations) as Locale[];

function detectBrowserLocale(): Locale {
  if (typeof navigator === 'undefined') return 'vi';
  for (const lang of navigator.languages ?? [navigator.language]) {
    const code = lang.split('-')[0].toLowerCase();
    if (SUPPORTED_LOCALES.includes(code as Locale)) return code as Locale;
  }
  return 'vi';
}

function getStoredLocale(): Locale {
  if (typeof window === 'undefined') return 'vi';
  const stored = localStorage.getItem('locale');
  if (stored && stored in translations) return stored as Locale;
  return detectBrowserLocale();
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getStoredLocale);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem('locale', newLocale);
    document.documentElement.lang = newLocale;
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    let value = translations[locale]?.[key] ?? translations['vi']?.[key] ?? key;
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      });
    }
    return value;
  }, [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
