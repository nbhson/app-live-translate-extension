import { describe, it, expect } from 'vitest';
import { compactTranscriptState } from '../src/services/transcript/compact.js';

function makeCache(n) {
  return Array.from({ length: n }, (_, i) => ({
    root: { dataset: { index: i } },
    idx: i,
  }));
}

describe('compactTranscriptState', () => {
  it('no-op when under keepMax', () => {
    const st = { en: ['a', 'b'], vi: ['1', '2'], speakers: [0, 1], cache: makeCache(2), suggestions: {}, selectedIdx: null, lastCompressedIdx: 0 };
    const res = compactTranscriptState(st, 10);
    expect(res.shift).toBe(0);
  });

  it('drops oldest and reindexes en/vi/speakers', () => {
    const en = Array.from({ length: 10 }, (_, i) => `e${i}`);
    const vi = Array.from({ length: 10 }, (_, i) => `v${i}`);
    const speakers = Array.from({ length: 10 }, (_, i) => i % 2);
    const st = { en, vi, speakers, cache: makeCache(10), suggestions: {}, selectedIdx: null, lastCompressedIdx: 3 };
    const res = compactTranscriptState(st, 6);
    expect(res.shift).toBe(4);
    expect(res.en).toEqual(en.slice(4));
    expect(res.vi).toEqual(vi.slice(4));
    expect(res.speakers).toEqual(speakers.slice(4));
    expect(res.lastCompressedIdx).toBe(0);
  });

  it('remaps cache dataset.index', () => {
    const st = { en: Array.from({ length: 8 }, (_, i) => `e${i}`), cache: makeCache(8), suggestions: {}, selectedIdx: null, lastCompressedIdx: 0 };
    const res = compactTranscriptState(st, 5);
    // shift 3, new indices 0..4 correspond to old 3..7
    expect(res.cache[0].root.dataset.index).toBe(0);
    expect(res.cache[4].root.dataset.index).toBe(4);
    expect(res.cache[0].idx).toBe(0);
  });

  it('remaps suggestions keys', () => {
    const st = {
      en: Array.from({ length: 10 }, (_, i) => `e${i}`),
      cache: makeCache(10),
      suggestions: { 2: { q: 'old' }, 5: { q: 'keep' }, 9: { q: 'last' } },
      selectedIdx: 5,
      lastCompressedIdx: 0,
    };
    const res = compactTranscriptState(st, 6); // shift 4
    expect(res.suggestions).toEqual({ 1: { q: 'keep' }, 5: { q: 'last' } });
    expect(res.selectedIdx).toBe(1);
  });

  it('selectedIdx fallback to last when dropped', () => {
    const st = {
      en: Array.from({ length: 10 }, (_, i) => `e${i}`),
      cache: makeCache(10),
      suggestions: { 5: { q: 'a' }, 7: { q: 'b' } },
      selectedIdx: 2, // will be dropped
      lastCompressedIdx: 0,
    };
    const res = compactTranscriptState(st, 6); // shift 4, 2 dropped
    // selected 2 -> -2 invalid, fallback to last suggestion key (7-4=3)
    expect(res.selectedIdx).toBe(3);
  });

  it('clamps lastCompressedIdx', () => {
    const st = { en: Array.from({ length: 10 }, (_, i) => `e${i}`), cache: makeCache(10), suggestions: {}, selectedIdx: null, lastCompressedIdx: 2 };
    const res = compactTranscriptState(st, 6); // shift 4
    expect(res.lastCompressedIdx).toBe(0);
  });

  it('handles missing arrays', () => {
    const res = compactTranscriptState({ en: [] }, 5);
    expect(res.shift).toBe(0);
  });
});
