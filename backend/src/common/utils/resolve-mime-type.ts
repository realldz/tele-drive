import { lookup } from 'mime-types';
import { extname } from 'path';

const GENERIC_MIME = 'application/octet-stream';
const GENERIC_MIME_TYPES = new Set([
  GENERIC_MIME,
  'application/x-octet-stream',
  'binary/octet-stream',
]);
const MIME_OVERRIDES = new Map<string, string>([
  ['.smali', 'text/plain'],
  ['.kt', 'text/plain'],
  ['.kts', 'text/plain'],
]);

/** Whether a client MIME value carries no useful type information. */
export function isGenericMimeType(value?: string | null): boolean {
  const mediaType = value?.split(';', 1)[0].trim().toLowerCase();
  return !mediaType || GENERIC_MIME_TYPES.has(mediaType);
}

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
  if (trimmed && !isGenericMimeType(trimmed)) {
    return trimmed;
  }

  const extension = extname(filename).toLowerCase();
  const fromExtension = MIME_OVERRIDES.get(extension) || lookup(filename);
  return fromExtension || GENERIC_MIME;
}
