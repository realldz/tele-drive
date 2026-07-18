/**
 * File format categories — single source of truth for search's `format` filter.
 * The frontend sends only the category label; the backend resolves it to a
 * Prisma where-fragment over mimeType / filename. `other` is the negation of the
 * union of all known categories (never a hand-written list) so it always covers
 * exactly what the known categories do not.
 */

export const FORMAT_CATEGORIES = [
  'image',
  'video',
  'audio',
  'document',
  'archive',
  'other',
] as const;

export type FormatCategory = (typeof FORMAT_CATEGORIES)[number];

type Matcher = {
  mimePrefixes?: string[];
  mimes?: string[];
  extensions?: string[]; // matched via filename endsWith, case-insensitive
};

/**
 * Known categories (everything except `other`). Match on mimeType primarily;
 * extensions are a fallback where mime is unreliable (e.g. `.md`, `.7z`).
 */
const KNOWN_MATCHERS: Record<Exclude<FormatCategory, 'other'>, Matcher> = {
  image: { mimePrefixes: ['image/'] },
  video: { mimePrefixes: ['video/'] },
  audio: { mimePrefixes: ['audio/'] },
  document: {
    mimePrefixes: ['text/'],
    mimes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/rtf',
    ],
    extensions: [
      '.pdf',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.ppt',
      '.pptx',
      '.txt',
      '.md',
      '.csv',
      '.rtf',
    ],
  },
  archive: {
    mimes: [
      'application/zip',
      'application/x-rar-compressed',
      'application/vnd.rar',
      'application/x-7z-compressed',
      'application/x-tar',
      'application/gzip',
      'application/x-gzip',
    ],
    extensions: ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2'],
  },
};

/** Build the OR-conditions for a single known category. */
function matcherConditions(m: Matcher): Record<string, unknown>[] {
  const or: Record<string, unknown>[] = [];
  for (const prefix of m.mimePrefixes ?? []) {
    or.push({ mimeType: { startsWith: prefix, mode: 'insensitive' } });
  }
  if (m.mimes?.length) {
    or.push({ mimeType: { in: m.mimes } });
  }
  for (const ext of m.extensions ?? []) {
    or.push({ filename: { endsWith: ext, mode: 'insensitive' } });
  }
  return or;
}

/**
 * Return a Prisma `FileRecord` where-fragment for the given format category,
 * or `null` if the category is unknown (caller should ignore the filter).
 */
export function buildFormatWhere(
  category?: string,
): Record<string, unknown> | null {
  if (!category || !FORMAT_CATEGORIES.includes(category as FormatCategory)) {
    return null;
  }

  if (category === 'other') {
    // Negation of the union of every known category.
    const allKnown = (
      Object.keys(KNOWN_MATCHERS) as Exclude<FormatCategory, 'other'>[]
    ).flatMap((k) => matcherConditions(KNOWN_MATCHERS[k]));
    return { NOT: { OR: allKnown } };
  }

  return {
    OR: matcherConditions(
      KNOWN_MATCHERS[category as Exclude<FormatCategory, 'other'>],
    ),
  };
}
