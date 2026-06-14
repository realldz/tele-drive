'use client';

import { UPLOAD_MIN_REQUEST_INTERVAL_MS } from '@/lib/constants';

/**
 * Serializes the *start* of upload requests (init / chunk / complete) so that
 * consecutive calls begin at least UPLOAD_MIN_REQUEST_INTERVAL_MS apart. This
 * smooths the request burst produced by many small files (each small file is
 * init → chunk → complete in quick succession) which otherwise hammers the API
 * and triggers 429 / extra server load.
 *
 * Only the gap between request *starts* is throttled — once a request is in
 * flight the pacer is free for the next caller. Large-file chunks therefore see
 * negligible impact: their transfer time already exceeds the interval.
 */

let chainTail: Promise<void> = Promise.resolve();
let lastStartAt = 0;

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Await a paced slot before issuing an upload request. Resolves once enough time
 * has elapsed since the previous slot was granted.
 */
export function acquireUploadSlot(): Promise<void> {
  const wait = chainTail.then(async () => {
    const now = Date.now();
    const elapsed = now - lastStartAt;
    if (elapsed < UPLOAD_MIN_REQUEST_INTERVAL_MS) {
      await delay(UPLOAD_MIN_REQUEST_INTERVAL_MS - elapsed);
    }
    lastStartAt = Date.now();
  });
  // Keep the chain alive even if a waiter is cancelled/rejected upstream.
  chainTail = wait.catch(() => undefined);
  return wait;
}
