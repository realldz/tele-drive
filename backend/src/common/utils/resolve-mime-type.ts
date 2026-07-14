import { lookup } from 'mime-types';

const GENERIC_MIME = 'application/octet-stream';

/**
 * Resolve the authoritative MIME type for a stored file.
 *
 * Browsers leave `File.type` empty for any extension the OS has no registered
 * association for (`.md`, `.ts`, `.yaml`, `.epub`, `.apk`, `.heic`, `.mkv`, …),
 * so the client sends the generic `application/octet-stream`. When that happens
 * we derive the type from the filename extension instead. A specific
 * client-provided type is always trusted.
 */
export function resolveMimeType(
  filename: string,
  clientMimeType?: string | null,
): string {
  const trimmed = clientMimeType?.trim();
  if (trimmed && trimmed !== GENERIC_MIME) {
    return trimmed;
  }

  const fromExtension = lookup(filename);
  return fromExtension || GENERIC_MIME;
}
