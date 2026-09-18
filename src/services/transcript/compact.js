/**
 * Transcript compaction — drop the oldest utterances past a memory cap and
 * re-index everything (DOM cache, suggestions, compress pointer).
 * Pure function, no side effects: caller applies returned state.
 * @module services/transcript/compact
 */

/**
 * Compute compacted transcript state.
 * Does NOT mutate input; returns a fresh object.
 * @param {object} st
 * @param {object} st.en - chronological EN phrases (index 0 = oldest)
 * @param {object} [st.vi]
 * @param {object} [st.speakers]
 * @param {object} [st.cache] - per-index DOM cache (may contain null/undefined holes)
 * @param {object} [st.suggestions] - map idx -> suggestion data
 * @param {number|null|undefined} [st.selectedIdx]
 * @param {number} [st.lastCompressedIdx]
 * @param {number} keepMax - target length after compaction
 * @returns {object} { en, vi, speakers, cache, suggestions, selectedIdx, lastCompressedIdx, shift }
 */
export function compactTranscriptState(st, keepMax) {
  const en = Array.isArray(st?.en) ? st.en.slice() : [];
  const keep = Math.max(1, keepMax | 0);
  if (en.length <= keep) return { shift: 0 };

  const n = en.length - keep;
  if (n <= 0) return { shift: 0 };

  const next = {
    en: en.slice(n),
    vi: (Array.isArray(st.vi) ? st.vi : []).slice(n),
    speakers: (Array.isArray(st.speakers) ? st.speakers : []).slice(n),
    cache: new Array(keep),
    suggestions: {},
    selectedIdx: null,
    lastCompressedIdx: Math.max(0, (Number(st.lastCompressedIdx) || 0) - n),
    shift: n,
  };

  if (Array.isArray(st.cache)) {
    st.cache.forEach((c, oldIdx) => {
      if (!c) return;
      const newIdx = oldIdx - n;
      if (newIdx < 0) return; // caller must remove/prune DOM for dropped nodes
      next.cache[newIdx] = c;
      if (c.root && typeof c.root === 'object' && 'dataset' in c.root) c.root.dataset.index = newIdx;
      if (typeof c.idx === 'number') c.idx = newIdx;
    });
  }

  if (st.suggestions && typeof st.suggestions === 'object') {
    for (const k of Object.keys(st.suggestions)) {
      const ki = Number(k);
      if (Number.isFinite(ki) && ki >= n) next.suggestions[ki - n] = st.suggestions[k];
    }
  }

  const sel = st.selectedIdx === null || st.selectedIdx === undefined ? null : Number(st.selectedIdx);
  if (sel !== null && Number.isFinite(sel)) {
    const a = sel - n;
    next.selectedIdx = (a >= 0 && next.suggestions[a]) ? a : null;
  }
  if (next.selectedIdx === null && Object.keys(next.suggestions).length) {
    const keys = Object.keys(next.suggestions).map(Number).sort((x, y) => x - y);
    next.selectedIdx = keys[keys.length - 1];
  }

  return next;
}