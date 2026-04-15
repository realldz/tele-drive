'use client';

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useRequestTracker } from '@/lib/request-tracker';

interface NavigationContextType {
  isNavigating: boolean;
}

const NavigationContext = createContext<NavigationContextType>({ isNavigating: false });

export function useNavigation() {
  return useContext(NavigationContext);
}

/**
 * Custom navigation progress bar for Next.js App Router.
 *
 * Driven by two signals:
 * 1. `pathname` change → start progress bar (user is navigating)
 * 2. `pendingCount === 0` after being > 0 → API requests finished → complete bar
 *
 * Safety net: auto-completes after 2s even with no requests.
 */
export default function NavigationLoader({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { pendingCount } = useRequestTracker();
  const isFirstMount = useRef(true);

  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);

  const incrementRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasPendingRef = useRef(false);

  const clearAllTimers = useCallback(() => {
    if (incrementRef.current) {
      clearInterval(incrementRef.current);
      incrementRef.current = null;
    }
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const finishNavigation = useCallback(() => {
    clearAllTimers();
    wasPendingRef.current = false;
    setProgress(100);
    hideTimerRef.current = setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 300);
  }, [clearAllTimers]);

  const startNavigation = useCallback(() => {
    clearAllTimers();
    wasPendingRef.current = false;
    setVisible(true);
    setProgress(0);

    setTimeout(() => setProgress(8), 30);

    incrementRef.current = setInterval(() => {
      setProgress(prev => {
        if (prev >= 80) {
          if (incrementRef.current) clearInterval(incrementRef.current);
          return prev;
        }
        return prev + (80 - prev) * 0.1;
      });
    }, 150);

    // Safety net: auto-complete after 2s if no requests triggered
    safetyTimerRef.current = setTimeout(finishNavigation, 2000);
  }, [clearAllTimers, finishNavigation]);

  // Start navigation on pathname change
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    startNavigation();
  }, [pathname, startNavigation]);

  // Finish navigation when all API requests complete
  useEffect(() => {
    if (isFirstMount.current) return;

    if (pendingCount > 0) {
      wasPendingRef.current = true;
    }

    if (wasPendingRef.current && pendingCount === 0 && visible) {
      finishNavigation();
    }
  }, [pendingCount, visible, finishNavigation]);

  return (
    <NavigationContext.Provider value={{ isNavigating: visible }}>
      <div
        className="fixed top-0 left-0 right-0 z-[9999] pointer-events-none"
        style={{
          opacity: visible ? 1 : 0,
          transition: 'opacity 200ms ease-in-out',
        }}
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
