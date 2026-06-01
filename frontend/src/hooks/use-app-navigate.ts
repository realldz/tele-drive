'use client';

import { useRouter } from 'next/navigation';
import { useNavigation } from '@/components/navigation-loader';

export function useAppNavigate() {
  const router = useRouter();
  const { startNavigation } = useNavigation();

  return {
    push: (href: string) => {
      if (typeof window !== 'undefined') {
        try {
          const url = new URL(href, window.location.origin);
          if (url.origin === window.location.origin && url.pathname === window.location.pathname) {
            router.push(href);
            return;
          }
        } catch {
          // ignore
        }
      }
      startNavigation();
      router.push(href);
    },
    replace: (href: string) => {
      if (typeof window !== 'undefined') {
        try {
          const url = new URL(href, window.location.origin);
          if (url.origin === window.location.origin && url.pathname === window.location.pathname) {
            router.replace(href);
            return;
          }
        } catch {
          // ignore
        }
      }
      startNavigation();
      router.replace(href);
    },
    back: () => {
      startNavigation();
      router.back();
    },
  };
}
