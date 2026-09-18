const SENT_END_RE = (() => {
  try {
    new RegExp('(?<=[.!?])');
    return /(?<=[.!?])\s+(?=[A-Z0-9"']|\()|(?<=[.!?])\s*$/;
  } catch {
    return /[.!?]+\s+/;
  }
})();
const STRONG_SPLIT_WORDS = Object.freeze(['how', 'what', 'why', 'where', 'when', 'who', 'which']);
const MIN_PREFIX_WORDS = 3;
// Abbreviations that should NOT trigger sentence split
const ABBREVS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'inc', 'ltd', 'co']);

/**
 * Pure: split block into utterances — no side effects, validated, Safari fallback.
 * @param {unknown} text
 * @returns {string[]}
 */
export function splitIntoUtterances(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  // Pre-process: protect abbrev dots to avoid false splits
  let protectedText = trimmed;
  // we don't actually replace SENT_END_RE splitting yet, but handle "Dr. Smith" case by merging back later
  const segs = protectedText
    .split(SENT_END_RE)
    .map((s) => s.trim())
    .filter(Boolean);

  // merge back abbrev splits: if previous seg ends with abbrev (lowercase + dot) and next starts lower? Actually abbrev list
  const merged = [];
  for (let i = 0; i < segs.length; i++) {
    const cur = segs[i];
    if (merged.length > 0) {
      const prev = merged[merged.length - 1];
      const prevLastWord = prev.split(/\s+/).pop()?.replace(/\.+$/, '').toLowerCase() || '';
      if (ABBREVS.has(prevLastWord) && /^[a-z]/.test(cur) === false) {
        // merge: prev was "Mr." and cur "Smith went" -> join with space
        merged[merged.length - 1] = prev + ' ' + cur;
        continue;
      }
    }
    merged.push(cur);
  }

  const out = [];
  for (const seg of merged) {
    const lower = seg.toLowerCase();
    let splitPos = -1;
    let splitWord = '';
    for (const word of STRONG_SPLIT_WORDS) {
      // word boundary: must be standalone word, not substring (e.g., however)
      const re = new RegExp(`\\b${word}\\b`, 'i');
      const m = re.exec(seg);
      if (m && m.index > 0) {
        const prefix = seg.slice(0, m.index).trim();
        const prefixWords = prefix ? prefix.split(/\s+/).length : 0;
        if (prefixWords >= MIN_PREFIX_WORDS) {
          // prefer earliest split (smallest index) that meets threshold
          if (splitPos === -1 || m.index < splitPos) {
            splitPos = m.index;
            splitWord = word;
          }
        }
      }
    }
    // also handle contraction "how's/what's" — normalize by checking lower
    if (splitPos === -1) {
      // check for "hows/whats" without apostrophe due to STT
      for (const w of ['hows', 'whats', 'wheres', 'whos']) {
        const idx = lower.indexOf(w + ' ');
        if (idx > 0) {
          const prefix = seg.slice(0, idx).trim();
          if (prefix.split(/\s+/).length >= MIN_PREFIX_WORDS) { splitPos = idx; break; }
        }
      }
    }
    if (splitPos > 0) {
      const left = seg.slice(0, splitPos).trim();
      const right = seg.slice(splitPos).trim();
      // avoid splitting if right side is too short (<2 words) — likely false positive
      if (left && right && right.split(/\s+/).length >= 2) {
        out.push(left);
        out.push(right);
      } else {
        out.push(seg);
      }
    } else {
      out.push(seg);
    }
  }
  return out.filter(Boolean);
}

// Export internals for testing
export const _internals = { SENT_END_RE, STRONG_SPLIT_WORDS, MIN_PREFIX_WORDS };
