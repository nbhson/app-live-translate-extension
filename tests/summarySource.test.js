import { describe, it, expect } from 'vitest';
import {
  SUMMARY_CHUNK_CHARS,
  COMPRESSED_SUMMARY_MAX_CHARS,
  FULL_HISTORY_MAX_UTTERANCES,
  appendFullHistory,
  pickSummaryUtterances,
  splitSummaryChunks,
  buildChunkPrompt,
  buildMergePrompt,
} from '../src/services/summary/summarySource.js';

describe('summarySource (full-meeting summary, no head loss)', () => {
  it('appendFullHistory keeps everything and caps only past max', () => {
    const h = appendFullHistory(['a', 'b'], ['c', '  ', 'd']);
    expect(h).toEqual(['a', 'b', 'c', 'd']);
    const big = appendFullHistory(
      Array.from({ length: FULL_HISTORY_MAX_UTTERANCES }, (_, i) => `u${i}`),
      ['new1', 'new2'],
    );
    expect(big.length).toBe(FULL_HISTORY_MAX_UTTERANCES);
    expect(big[big.length - 1]).toBe('new2');
    expect(big).toContain('new1');
  });

  it('pickSummaryUtterances prefers full history over live window', () => {
    const full = Array.from({ length: 500 }, (_, i) => `early-${i}`);
    const live = Array.from({ length: 120 }, (_, i) => `recent-${i}`);
    const picked = pickSummaryUtterances({ fullHistory: full, livePhrases: live });
    expect(picked.length).toBe(500);
    expect(picked[0]).toBe('early-0');
  });

  it('pickSummaryUtterances falls back to live window when no history', () => {
    expect(pickSummaryUtterances({ fullHistory: [], livePhrases: ['a'] })).toEqual(['a']);
  });

  it('splitSummaryChunks keeps all 500 utterances of a 1h meeting', () => {
    const utterances = Array.from(
      { length: 500 },
      (_, i) => `utterance number ${i} about project planning and decisions made early`,
    );
    const chunks = splitSummaryChunks(utterances, SUMMARY_CHUNK_CHARS);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBe(500);
    expect(chunks.length).toBeGreaterThan(1); // long meeting must be chunked, not truncated
    for (const c of chunks) {
      expect(c.join('\n').length).toBeLessThanOrEqual(SUMMARY_CHUNK_CHARS + 500);
    }
    // chronological order preserved
    expect(chunks[0][0]).toContain('utterance number 0');
    expect(chunks[chunks.length - 1].at(-1)).toContain('utterance number 499');
  });

  it('buildChunkPrompt embeds compressedSummary only in first chunk', () => {
    const comp = '- early decision: launch plan';
    const p0 = buildChunkPrompt('hello', { lang: 'en', detail: 'bullets', chunkIndex: 0, totalChunks: 3, compressedSummary: comp });
    const p1 = buildChunkPrompt('hello', { lang: 'en', detail: 'bullets', chunkIndex: 1, totalChunks: 3, compressedSummary: comp });
    expect(p0).toContain(comp);
    expect(p0).toContain('part 1/3');
    expect(p1).not.toContain(comp);
    expect(p1).toContain('part 2/3');
  });

  it('buildMergePrompt covers whole meeting and respects lang/detail', () => {
    const p = buildMergePrompt(['sum A', 'sum B'], { lang: 'vi', detail: 'action' });
    expect(p).toContain('sum A');
    expect(p).toContain('sum B');
    expect(p).toContain('Vietnamese');
    expect(p).toContain('Action Items');
    expect(p).toContain('do not drop early parts');
  });

  it('caps are sane for hour-long meetings', () => {
    expect(COMPRESSED_SUMMARY_MAX_CHARS).toBeGreaterThanOrEqual(12000);
    expect(SUMMARY_CHUNK_CHARS).toBeGreaterThanOrEqual(8000);
  });
});
