'use client';

import { useRouter } from 'next/navigation';
import { useNavigation } from '@/components/navigation-loader';

export function useAppNavigate() {
  const router = useRouter();
  const { startNavigation } = useNavigation();

  return {
    push: (href: string) => {
      startNavigation();
      router.push(href);
    },
    replace: (href: string) => {
      startNavigation();
      router.replace(href);
    },
    back: () => {
      startNavigation();
      router.back();
    },
  };
}
