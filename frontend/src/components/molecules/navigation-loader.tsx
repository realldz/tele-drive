'use client';

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

interface NavigationContextType {
  isNavigating: boolean;
  startNavigation: () => void;
}

const NavigationContext = createContext<NavigationContextType>({
  isNavigating: false,
  startNavigation: () => {},
});

export function useNavigation() {
  return useContext(NavigationContext);
}

/**
 * Custom navigation progress bar for Next.js App Router.
 * Driven by internal link clicks and pathname changes only.
 */
export default function NavigationLoader({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isFirstMount = useRef(true);
  const lastPathnameRef = useRef(pathname);

  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);

  const incrementRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  const clearAllTimers = useCallback(() => {
    if (incrementRef.current) { clearInterval(incrementRef.current); incrementRef.current = null; }
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    if (resetTimerRef.current) { clearTimeout(resetTimerRef.current); resetTimerRef.current = null; }
    if (safetyTimerRef.current) { clearTimeout(safetyTimerRef.current); safetyTimerRef.current = null; }
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }, []);

  const finishNavigation = useCallback(() => {
    clearAllTimers();
    setProgress(100);
    hideTimerRef.current = setTimeout(() => {
      setVisible(false);
      hideTimerRef.current = null;
      resetTimerRef.current = setTimeout(() => { setProgress(0); resetTimerRef.current = null; }, 220);
    }, 300);
  }, [clearAllTimers]);

  const startNavigation = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    if (visible) return;
    clearAllTimers();
    setVisible(true);
    setProgress(0);
    setTimeout(() => setProgress(8), 30);
    incrementRef.current = setInterval(() => {
      setProgress(prev => {
        if (prev >= 80) { if (incrementRef.current) clearInterval(incrementRef.current); return prev; }
        return prev + (80 - prev) * 0.1;
      });
    }, 150);
    safetyTimerRef.current = setTimeout(() => { finishNavigation(); }, 8000);
  }, [clearAllTimers, finishNavigation, visible]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === lastPathnameRef.current) return;
      startNavigation();
    };
    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [startNavigation]);

  useEffect(() => {
    if (isFirstMount.current) { isFirstMount.current = false; lastPathnameRef.current = pathname; return; }
    if (pathname !== lastPathnameRef.current) {
      lastPathnameRef.current = pathname;
      if (!visible) setTimeout(() => startNavigation(), 0);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = requestAnimationFrame(() => { rafRef.current = null; finishNavigation(); });
      });
    }
  }, [pathname, finishNavigation, startNavigation, visible]);

  return (
    <NavigationContext.Provider value={{ isNavigating: visible, startNavigation }}>
      <div
        className="fixed top-0 left-0 right-0 z-[9999] pointer-events-none"
        style={{ opacity: visible ? 1 : 0, transition: 'opacity 200ms ease-in-out' }}
      >
        <div
          className="h-[3px] bg-blue-500"
          style={{
            width: `${progress}%`,
            transition: progress === 100 ? 'width 300ms ease-in-out' : 'width 150ms ease-in-out',
            boxShadow: '0 0 10px #3B82F6, 0 0 5px #3B82F6',
          }}
        />
      </div>
      {children}
    </NavigationContext.Provider>
  );
}
