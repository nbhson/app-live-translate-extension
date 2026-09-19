import { describe, it, expect } from 'vitest';
import { getContextSnapshot, formatInspectorMeta } from '../src/ui/components/contextInspector.js';

describe('contextInspector', () => {
  it('live mode without compress', () => {
    const snap = getContextSnapshot({
      finalizedEnPhrases: ['hello', 'how are you', 'fine'],
      compressedSummary: '',
      compressEnabled: false,
      lastCompressedIdx: 0,
    });
    expect(snap.stats.mode).toBe('live');
    expect(snap.liveCtx).toContain('Context last 3');
    expect(snap.pendingList).toHaveLength(3);
    expect(formatInspectorMeta(snap)).toContain('📝');
  });

  it('compressed mode shows recent 10 + history', () => {
    const phrases = Array.from({ length: 12 }, (_, i) => `sentence ${i}`);
    const comp = '- bullet 1\n- bullet 2';
    const snap = getContextSnapshot({
      finalizedEnPhrases: phrases,
      compressedSummary: comp,
      compressEnabled: true,
      lastCompressedIdx: 5,
    });
    expect(snap.stats.mode).toBe('compressed');
    expect(snap.compressedPreview).toContain('bullet');
    expect(snap.pendingList).toHaveLength(7);
    expect(snap.liveCtx).toContain('Compressed history');
    expect(snap.liveCtx).toContain('Recent');
    expect(formatInspectorMeta(snap)).toContain('🗜️');
  });

  it('handles empty state', () => {
    const snap = getContextSnapshot({
      finalizedEnPhrases: [],
      compressedSummary: '',
      compressEnabled: true,
      lastCompressedIdx: 0,
    });
    expect(snap.liveCtx).toContain('empty');
    expect(snap.compressedPreview).toContain('no compressed');
    expect(snap.pendingList).toHaveLength(0);
  });

  it('truncates long context', () => {
    const long = 'a'.repeat(2000);
    const snap = getContextSnapshot({
      finalizedEnPhrases: [long, long],
      compressedSummary: '',
      compressEnabled: false,
      lastCompressedIdx: 0,
    });
    expect(snap.liveCtx.length).toBeLessThan(1200);
  });
});
