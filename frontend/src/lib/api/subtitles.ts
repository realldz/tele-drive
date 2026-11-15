import { getPreviewUrl } from '@/lib/api/transfer';
import { SUBTITLE_MAX_BYTES, API_TIMEOUT_MS } from '@/lib/constants';
import { normalizeSubtitle, SubtitleError, validateSubtitleFile } from '@/lib/subtitles';
import type { FileRecord } from '@/lib/types';

/** Authorize with the shared API, then read the signed URL without forwarding JWTs. */
export async function loadDriveSubtitle(file: FileRecord, signal: AbortSignal): Promise<string> {
  validateSubtitleFile(file.filename, Number(file.size));
  const { url } = await getPreviewUrl(file.id);
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, API_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
    if (!response.ok) throw new Error('Subtitle request failed');
    const length = response.headers.get('content-length');
    if (length && Number(length) > SUBTITLE_MAX_BYTES) throw new SubtitleError('tooLarge');
    if (!response.body) throw new SubtitleError('invalidContent');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    let text = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > SUBTITLE_MAX_BYTES) throw new SubtitleError('tooLarge');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return normalizeSubtitle(text, file.filename);
  } finally {
    void reader?.cancel().catch(() => {});
    controller.abort();
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
