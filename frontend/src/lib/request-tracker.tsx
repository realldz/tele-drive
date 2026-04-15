'use client';

import { createContext, useContext, useState, useRef, useCallback, useEffect, type ReactNode } from 'react';

interface RequestTrackerContextType {
  pendingCount: number;
  showOverlay: boolean;
  trackRequest: <T>(fn: () => Promise<T>) => Promise<T>;
}

const OVERLAY_DELAY_MS = 500;

const RequestTrackerContext = createContext<RequestTrackerContextType | undefined>(undefined);

export function RequestTrackerProvider({ children }: { children: ReactNode }) {
  const [pendingCount, setPendingCount] = useState(0);
  const [showOverlay, setShowOverlay] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pendingCount > 0) {
      // Delay before showing overlay to avoid flash for fast requests
      timerRef.current = setTimeout(() => setShowOverlay(true), OVERLAY_DELAY_MS);
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
      setShowOverlay(false);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [pendingCount]);

  const trackRequest = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setPendingCount(prev => prev + 1);
    try {
      const result = await fn();
      return result;
    } finally {
      setPendingCount(prev => prev - 1);
    }
  }, []);

  return (
    <RequestTrackerContext.Provider value={{ pendingCount, showOverlay, trackRequest }}>
      {children}
    </RequestTrackerContext.Provider>
  );
}

export function useRequestTracker() {
  const context = useContext(RequestTrackerContext);
  if (context === undefined) {
    throw new Error('useRequestTracker must be used within a RequestTrackerProvider');
  }
  return context;
}

/**
 * Increment/decrement pending count for axios interceptors.
 * Not a hook — called directly from interceptor scope.
 */
let incrementFn: (() => void) | null = null;
let decrementFn: (() => void) | null = null;

export function registerPendingCountControls(increment: () => void, decrement: () => void) {
  incrementFn = increment;
  decrementFn = decrement;
}

export function incPendingCount() {
  incrementFn?.();
}

export function decPendingCount() {
  decrementFn?.();
}
