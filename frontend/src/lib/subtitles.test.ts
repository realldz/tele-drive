import { describe, expect, it } from 'vitest';
import { normalizeSubtitle, validateSubtitleFile } from '@/lib/subtitles';
import { SUBTITLE_MAX_BYTES } from '@/lib/constants';

describe('subtitle normalization', () => {
  it('converts SRT timestamps, BOM and CRLF while preserving multiline Vietnamese text', () => {
    const result = normalizeSubtitle('\uFEFF1\r\n00:00:01,250 --> 00:00:03,000\r\nXin chào\r\nDòng hai\r\n\r\n2\r\n01:02:00,000 --> 01:02:01,000\r\nTiếp theo', 'movie.SRT');
    expect(result).toBe('WEBVTT\n\n1\n00:00:01.250 --> 00:00:03.000\nXin chào\nDòng hai\n\n2\n01:02:00.000 --> 01:02:01.000\nTiếp theo\n');
  });
  it('preserves WebVTT settings, cue identifiers and NOTE blocks', () => {
    const text = 'WEBVTT\n\nNOTE comment\nignored\n\nintro\n00:01.000 --> 00:02.000 align:start\n<b>Hello</b>';
    expect(normalizeSubtitle(text, 'movie.vtt')).toBe(text + '\n');
  });
  it.each([
    ['<html>Error</html>', 'movie.vtt'],
    ['WEBVTT\n\nNOTE no cues', 'movie.vtt'],
    ['1\n00:00:03,000 --> 00:00:01,000\nBackwards', 'movie.srt'],
    ['1\n00:61:00,000 --> 00:62:00,000\nBad minute', 'movie.srt'],
    ['1\n00:00:01,000 --> 00:00:02,000', 'movie.srt'],
    ['', 'movie.srt'],
  ])('rejects invalid subtitles: %s', (text, name) => {
    expect(() => normalizeSubtitle(text, name)).toThrow('invalidContent');
  });
  it.each(['srt', 'vtt'])('accepts repeated blank separator lines in %s files', extension => {
    const header = extension === 'vtt' ? 'WEBVTT\n\n\n' : '';
    const text = `${header}1\n00:00:01.000 --> 00:00:02.000\nOne\n\n\n\n2\n00:00:03.000 --> 00:00:04.000\nTwo`;
    expect(normalizeSubtitle(text, `movie.${extension}`)).toContain('Two');
  });
  it('rejects wrong extensions and oversized/empty files', () => {
    expect(() => validateSubtitleFile('test.ass', 20)).toThrow('invalidFile');
    expect(() => validateSubtitleFile('test.srt', SUBTITLE_MAX_BYTES + 1)).toThrow('tooLarge');
    expect(() => validateSubtitleFile('test.srt', 0)).toThrow('invalidContent');
    expect(() => validateSubtitleFile('test.VTT', SUBTITLE_MAX_BYTES)).not.toThrow();
  });
});
