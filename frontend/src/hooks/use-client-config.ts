import { useSyncExternalStore } from 'react';
import { getS3Domain, subscribeClientConfig, toS3Endpoint } from '@/lib/api';

/**
 * S3-compatible endpoint advertised by the backend, or null when S3 is not
 * configured (S3_DOMAIN unset / placeholder).
 *
 * The value is part of the runtime client config (it replaced the build-time
 * NEXT_PUBLIC_S3_DOMAIN), so it can arrive after first paint — subscribing
 * through the shared store re-renders the keys page once it does.
 */
export function useS3Endpoint(): string | null {
  const domain = useSyncExternalStore(
    subscribeClientConfig,
    getS3Domain,
    () => null,
  );
  return toS3Endpoint(domain);
}
