'use client';

/**
 * Serializes upload `init` calls and pauses the pipeline the moment a conflict
 * (HTTP 409) is awaiting the user's decision.
 *
 * Why this exists: uploading a folder that already exists used to fire an
 * `init` for every file in quick succession (batched + concurrent), so the API
 * was hammered with 409s before the user could resolve anything. With this
 * gate, init calls run one at a time and the FIRST 409 pauses every queued init
 * until the conflict is resolved (`resumeInitAfterConflict`).
 *
 * Only `init` is gated — chunk upload and complete are unaffected, so a single
 * large file still streams its chunks in parallel.
 */

let pausedForConflict = false;
let resumeWaiters: Array<() => void> = [];
let initChain: Promise<void> = Promise.resolve();

/** Engage the pause. Called synchronously by the engine when init returns 409. */
export function pauseInitForConflict(): void {
  pausedForConflict = true;
}

/** Release the pause and wake every init blocked on the gate. */
export function resumeInitAfterConflict(): void {
  if (!pausedForConflict && resumeWaiters.length === 0) return;
  pausedForConflict = false;
  const waiters = resumeWaiters;
  resumeWaiters = [];
  waiters.forEach((wake) => wake());
}

function waitWhilePaused(): Promise<void> {
  if (!pausedForConflict) return Promise.resolve();
  return new Promise<void>((resolve) => resumeWaiters.push(resolve));
}

/**
 * Run an `init` request serialized against all other init calls and gated on
 * the conflict pause. `fn` MUST call {@link pauseInitForConflict} synchronously
 * when it detects a 409, so the next serialized init observes the pause before
 * it starts.
 */
export function runGatedInit<T>(fn: () => Promise<T>): Promise<T> {
  const result = initChain.then(async () => {
    await waitWhilePaused();
    return fn();
  });
  // Keep the chain alive regardless of this init's outcome.
  initChain = result.then(() => undefined, () => undefined);
  return result;
}
