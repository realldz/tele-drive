'use client';

import { useRequestTracker } from '@/lib/request-tracker';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import { useEffect, useState } from 'react';

/* eslint-disable react-hooks/set-state-in-effect */

export default function LoadingOverlay() {
  const { showOverlay } = useRequestTracker();
  const { t } = useI18n();
  const [rendered, setRendered] = useState(false);
  const [opacity, setOpacity] = useState(0);

  useEffect(() => {
    if (showOverlay) {
      setRendered(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setOpacity(1)));
    } else {
      setOpacity(0);
      const timer = setTimeout(() => setRendered(false), 350);
      return () => clearTimeout(timer);
    }
  }, [showOverlay]);

  if (!rendered) return null;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/30 backdrop-blur-[1px] pointer-events-none"
      style={{
        opacity,
        transition: 'opacity 350ms ease-in-out',
      }}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3 bg-white/90 rounded-xl px-6 py-4 shadow-lg">
        <Loader2 className="animate-spin text-blue-500" size={28} />
        <span className="text-sm font-medium text-gray-700">{t('dashboard.loading')}</span>
      </div>
    </div>
  );
}
