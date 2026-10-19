import { api, applyClientConfig, getTransferUrl } from './client';

export interface ClientConfig {
  /** Data-plane origin (dedicated transfer domain), null = same origin. */
  transferUrl: string | null;
  /** S3 host advertised by the backend, null = S3 not configured. */
  s3Domain: string | null;
}

// Legacy behavior: no dedicated transfer domain, S3 not advertised.
const FALLBACK_CONFIG: ClientConfig = { transferUrl: null, s3Domain: null };

let pending: Promise<ClientConfig> | null = null;

/**
 * Fetches the runtime client config once from the control-plane origin
 * (`GET /client-config`) and applies it to the shared axios instances.
 *
 * Replaces the build-time NEXT_PUBLIC_TRANSFER_URL / NEXT_PUBLIC_S3_DOMAIN
 * values. Memoized — including failures: a backend that is briefly unreachable
 * at boot keeps the legacy single-origin behavior instead of retrying on every
 * call site.
 */
export function ensureClientConfig(): Promise<ClientConfig> {
  if (!pending) {
    pending = api
      .get<ClientConfig>('/client-config')
      .then((res) => {
        const config: ClientConfig = {
          transferUrl: res.data?.transferUrl ?? null,
          s3Domain: res.data?.s3Domain ?? null,
        };
        applyClientConfig(config);
        return config;
      })
      .catch(() => {
        applyClientConfig(FALLBACK_CONFIG);
        return FALLBACK_CONFIG;
      });
  }
  return pending;
}

/**
 * Resolves the data-plane origin, fetching the runtime config on first use.
 *
 * Await this before building a stream URL so the media URL and the stream
 * cookie (issued by `transferApi` against the same origin) can never disagree.
 */
export async function ensureTransferOrigin(): Promise<string> {
  await ensureClientConfig();
  return getTransferUrl();
}
