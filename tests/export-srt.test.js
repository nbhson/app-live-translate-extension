import { describe, it, expect } from 'vitest';
import {
  formatSrtTime,
  formatVttTime,
  buildCues,
  historyToSrt,
  historyToVtt,
  MIN_CUE_MS,
} from '../src/services/export-srt.js';
import { createHistoryEntry } from '../src/services/history.js';

const T0 = 1700000000000;

describe('export-srt service', () => {
  it('formatSrtTime emits standard 00:00:00,000 (comma msecs)', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(3661123)).toBe('01:01:01,123');
    expect(formatSrtTime(-5)).toBe('00:00:00,000');
  });

  it('formatVttTime uses dot separator', () => {
    expect(formatVttTime(1500)).toBe('00:00:01.500');
    expect(formatVttTime(7384007)).toBe('02:03:04.007');
  });

  it('buildCues: timecodes relative to first entry, end = next start', () => {
    const entries = [
      createHistoryEntry('Hello', 'Xin chào', T0),
      createHistoryEntry('How are you', 'Bạn thế nào', T0 + 2000),
    ];
    const cues = buildCues(entries);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 0, end: 2000, text: 'Hello\nXin chào' });
    expect(cues[1].start).toBe(2000);
    expect(cues[1].end).toBeGreaterThan(2000); // last cue: estimated duration
  });

  it('buildCues: identical en/vi not duplicated; empty entries filtered; never throws', () => {
    expect(buildCues(null)).toEqual([]);
    expect(buildCues([{ ts: T0, en: 'same', vi: 'same' }])[0].text).toBe('same');
    expect(buildCues([{ ts: T0, en: '', vi: '' }])).toEqual([]);
  });

  it('buildCues: out-of-order ts still yields end > start', () => {
    const cues = buildCues([
      { ts: T0 + 5000, en: 'b', vi: '' },
      { ts: T0 + 1000, en: 'a', vi: '' },
    ]);
    expect(cues[0].end).toBe(cues[0].start + MIN_CUE_MS);
    expect(cues[0].end).toBeGreaterThan(cues[0].start);
  });

  it('historyToSrt: numbered cues + blank-line separation + trailing newline', () => {
    const entries = [
      createHistoryEntry('Hello', 'Xin chào', T0),
      createHistoryEntry('How are you', 'Bạn thế nào', T0 + 2000),
    ];
    const srt = historyToSrt(entries);
    const blocks = srt.trim().split(/\n\n/);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(`1\n00:00:00,000 --> 00:00:02,000\nHello\nXin chào`);
    expect(blocks[1]).toMatch(/^2\n00:00:02,000 --> 00:00:\d\d,\d{3}\nHow are you\nBạn thế nào$/);
    expect(srt.endsWith('\n')).toBe(true);
  });

  it('historyToSrt: empty history → empty string', () => {
    expect(historyToSrt([])).toBe('');
    expect(historyToSrt(null)).toBe('');
  });

  it('historyToVtt: WEBVTT header + dot timecodes', () => {
    const entries = [createHistoryEntry('Hello', 'Xin chào', T0)];
    const vtt = historyToVtt(entries);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toContain('00:00:00.000 --> ');
    expect(vtt).toContain('Hello\nXin chào');
    expect(historyToVtt([])).toBe('WEBVTT\n');
  });
});
