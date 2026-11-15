import { SUBTITLE_MAX_BYTES } from '@/lib/constants';

export class SubtitleError extends Error {
  constructor(public readonly key: 'invalidFile' | 'tooLarge' | 'invalidContent') {
    super(key);
  }
}

export function validateSubtitleFile(filename: string, size: number) {
  if (!/\.(srt|vtt)$/i.test(filename)) throw new SubtitleError('invalidFile');
  if (!Number.isFinite(size) || size > SUBTITLE_MAX_BYTES) throw new SubtitleError('tooLarge');
  if (size <= 0) throw new SubtitleError('invalidContent');
}

const TIMING = /^((?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3})(.*)$/;

function seconds(timestamp: string) {
  const parts = timestamp.replace(',', '.').split(':').map(Number);
  const secs = parts.pop()!;
  const mins = parts.pop()!;
  if (secs >= 60 || mins >= 60) return NaN;
  return (parts.pop() ?? 0) * 3600 + mins * 60 + secs;
}

/** Normalize SRT to WebVTT. Rendering uses native text tracks, never innerHTML. */
export function normalizeSubtitle(content: string, filename: string): string {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const isVtt = /\.vtt$/i.test(filename);
  if (!text || text.includes('\0') || (isVtt && !/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text))) {
    throw new SubtitleError('invalidContent');
  }
  const blocks = text.split(/\n(?:[ \t]*\n)+/);
  let cueCount = 0;
  const normalized = blocks.map((block, index) => {
    if (isVtt && (index === 0 || /^(NOTE(?:[ \t\n]|$)|STYLE(?:\n|$)|REGION(?:\n|$))/.test(block))) return block;
    const lines = block.split('\n');
    const timingIndex = lines[0].includes('-->') ? 0 : 1;
    const match = lines[timingIndex]?.match(TIMING);
    if (!match || lines.length <= timingIndex + 1 || !(seconds(match[2]) > seconds(match[1]))) {
      throw new SubtitleError('invalidContent');
    }
    cueCount++;
    lines[timingIndex] = `${match[1].replace(',', '.')} --> ${match[2].replace(',', '.')}${isVtt ? match[3] : ''}`;
    return lines.join('\n');
  });
  if (!cueCount) throw new SubtitleError('invalidContent');
  return `${isVtt ? '' : 'WEBVTT\n\n'}${normalized.join('\n\n')}\n`;
}

export async function readSubtitleFile(file: File) {
  validateSubtitleFile(file.name, file.size);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new SubtitleError('invalidContent');
  }
  return normalizeSubtitle(text, file.name);
}
