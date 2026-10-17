import { Injectable, Logger } from '@nestjs/common';

/**
 * Optional CDN cache purge for deleted shared resources.
 *
 * When the transfer data plane serves shared download/stream routes with
 * cacheable response headers (see docs/cdn-cache/README.md), a file that later
 * gets permanently deleted still lives on the CDN until its TTL expires. With
 * `revalidate` mode the CDN falls back to the origin on every hit — an origin
 * 410/404 (uncacheable) drops the entry naturally — but operators using
 * aggressive `full` mode or `Cache Everything` rules can evict immediately by
 * enabling a purge provider.
 *
 * Providers (`CDN_PURGE_PROVIDER`):
 * - `none` (default): no-op.
 * - `cloudflare`: POST to the zone purge_cache API with an explicit URL list
 *   (Cloudflare supports up to 30 URLs per request).
 *
 * Configuration:
 * - `CDN_PURGE_PROVIDER`     — `none` | `cloudflare`
 * - `CLOUDFLARE_API_TOKEN`   — API token with `Zone.Cache Purge` permission
 * - `CDN_CACHE_PURGE_ZONE`   — Cloudflare zone ID
 * - `CDN_CACHE_PURGE_BASE`   — public origin serving the transfer routes
 *                              (falls back to `PUBLIC_TRANSFER_URL`)
 *
 * The purge URL list is best-effort: only cacheable *unguessable-free* URLs
 * (shared routes derive from the record's `shareToken`) can be listed. URLs
 * minted per request (`/files/d/<signed token>`) are unique by construction and
 * never need purging — each token string is its own cache key.
 */
@Injectable()
export class CdnPurgeService {
  private readonly logger = new Logger(CdnPurgeService.name);

  private readonly provider = (
    process.env.CDN_PURGE_PROVIDER || 'none'
  ).toLowerCase();
  private readonly apiToken = process.env.CLOUDFLARE_API_TOKEN;
  private readonly zoneId = process.env.CDN_CACHE_PURGE_ZONE;
  private readonly baseUrl = (
    process.env.CDN_CACHE_PURGE_BASE ||
    process.env.PUBLIC_TRANSFER_URL ||
    ''
  ).replace(/\/+$/, '');

  /** Cloudflare allows at most 30 file URLs per purge_cache request. */
  private static readonly CF_MAX_URLS = 30;

  purgeProviders(): string {
    return this.provider;
  }

  /**
   * Purges every cacheable shared route of the given deleted files. Safe to
   * call unconditionally from lifecycle paths — resolves to a debug no-op when
   * the provider is disabled or misconfigured. Never throws: purge failure
   * must not fail the deletion itself.
   */
  async purgeDeletedFiles(
    files: Array<{
      id: string;
      shareToken?: string | null;
      /** Tier-2: /public/<userId>/<rootFolder>/<path> when the file lived in a
       * public folder chain; lifecycle computes it, purge stays DB-free. */
      publicS3Path?: string | null;
    }>,
  ): Promise<void> {
    if (this.provider === 'none') return;
    const tokens = files
      .map((f) => f.shareToken)
      .filter((t): t is string => !!t);
    if (tokens.length === 0) return;
    const publicPaths = files
      .map((f) => f.publicS3Path)
      .filter((p): p is string => !!p);
    if (tokens.length === 0 && publicPaths.length === 0) return;

    if (!this.baseUrl) {
      this.logger.warn(
        `CDN_PURGE_PROVIDER=${this.provider} but no CDN_CACHE_PURGE_BASE/PUBLIC_TRANSFER_URL set — skipping purge of ${tokens.length + publicPaths.length} URL(s)`,
      );
      return;
    }

    const urls: string[] = [];
    for (const token of tokens) {
      urls.push(
        `${this.baseUrl}/files/share/${token}/download`,
        `${this.baseUrl}/files/share/${token}/stream`,
        `${this.baseUrl}/files/share/stream/${token}`,
      );
    }
    for (const path of publicPaths) {
      urls.push(`${this.baseUrl}${path}`);
    }

    await this.flush(
      urls,
      `for ${tokens.length} shared + ${publicPaths.length} public-S3 deleted file(s)`,
    );
  }

  /**
   * Purges `urls` in Cloudflare-sized batches. Shared error handling so
   * multiple purge call sites log consistently (best-effort, never throws).
   */
  private async flush(urls: string[], label: string): Promise<void> {
    if (urls.length === 0) return;
    this.logger.log(
      `CDN purge (${this.provider}): evicting ${urls.length} URL(s) ${label}`,
    );
    for (const batch of this.chunk(urls, CdnPurgeService.CF_MAX_URLS)) {
      try {
        await this.purgeCloudflare(batch);
      } catch (err) {
        this.logger.warn(
          `CDN purge failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  private async purgeCloudflare(files: string[]): Promise<void> {
    if (!this.apiToken || !this.zoneId) {
      this.logger.warn(
        'Cloudflare purge skipped: CLOUDFLARE_API_TOKEN or CDN_CACHE_PURGE_ZONE missing',
      );
      return;
    }

    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${this.zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files }),
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Cloudflare purge_cache HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      );
    }
    this.logger.debug(`Cloudflare purge_cache accepted ${files.length} URL(s)`);
  }

  private *chunk<T>(items: T[], size: number): Generator<T[]> {
    for (let i = 0; i < items.length; i += size) {
      yield items.slice(i, i + size);
    }
  }
}
