import { buildFormatWhere, FORMAT_CATEGORIES } from './file-format-category';

/**
 * Pure unit tests for the search format-category matcher. No DB — asserts the
 * Prisma where-fragment shape so the frontend↔backend category contract and the
 * `other = NOT(union of known)` negation stay correct.
 */
describe('buildFormatWhere', () => {
  it('returns null for missing / unknown categories (filter ignored)', () => {
    expect(buildFormatWhere(undefined)).toBeNull();
    expect(buildFormatWhere('')).toBeNull();
    expect(buildFormatWhere('bogus')).toBeNull();
  });

  it('image → mimeType startsWith image/ (insensitive)', () => {
    const w = buildFormatWhere('image') as { OR: Record<string, unknown>[] };
    expect(w.OR).toContainEqual({
      mimeType: { startsWith: 'image/', mode: 'insensitive' },
    });
  });

  it('video / audio map to their mime prefixes', () => {
    const video = buildFormatWhere('video') as {
      OR: Record<string, unknown>[];
    };
    const audio = buildFormatWhere('audio') as {
      OR: Record<string, unknown>[];
    };
    expect(video.OR).toContainEqual({
      mimeType: { startsWith: 'video/', mode: 'insensitive' },
    });
    expect(audio.OR).toContainEqual({
      mimeType: { startsWith: 'audio/', mode: 'insensitive' },
    });
  });

  it('document matches pdf mime + doc/text extensions', () => {
    const w = buildFormatWhere('document') as { OR: Record<string, unknown>[] };
    // pdf via explicit mime list
    const mimeIn = w.OR.find(
      (c) => 'mimeType' in c && 'in' in (c.mimeType as object),
    ) as {
      mimeType: { in: string[] };
    };
    expect(mimeIn.mimeType.in).toContain('application/pdf');
    // extension fallback (e.g. .md where mime is unreliable)
    expect(w.OR).toContainEqual({
      filename: { endsWith: '.md', mode: 'insensitive' },
    });
  });

  it('archive matches zip mime + .7z extension fallback', () => {
    const w = buildFormatWhere('archive') as { OR: Record<string, unknown>[] };
    const mimeIn = w.OR.find(
      (c) => 'mimeType' in c && 'in' in (c.mimeType as object),
    ) as {
      mimeType: { in: string[] };
    };
    expect(mimeIn.mimeType.in).toContain('application/zip');
    expect(w.OR).toContainEqual({
      filename: { endsWith: '.7z', mode: 'insensitive' },
    });
  });

  it('other = NOT(union of every known category), never a hand list', () => {
    const other = buildFormatWhere('other') as {
      NOT: { OR: Record<string, unknown>[] };
    };
    expect(other.NOT).toBeDefined();

    // The negated union must contain conditions from EACH known category, so it
    // stays in sync automatically when a known matcher changes.
    const knownUnion: Record<string, unknown>[] = [];
    for (const cat of FORMAT_CATEGORIES) {
      if (cat === 'other') continue;
      const w = buildFormatWhere(cat) as { OR: Record<string, unknown>[] };
      knownUnion.push(...w.OR);
    }
    // same length + every known condition present in the negation
    expect(other.NOT.OR).toHaveLength(knownUnion.length);
    for (const cond of knownUnion) {
      expect(other.NOT.OR).toContainEqual(cond);
    }
  });
});
