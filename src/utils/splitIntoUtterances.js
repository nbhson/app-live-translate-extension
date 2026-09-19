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

// Normalize STT artifacts: leading single-char noise + fused suffixes
function normalizeInput(text) {
  let s = String(text || '').trim();
  // "s How are you" / "n How are you" / "e okay here we go" -> strip leading single char before WH/tag
  s = s.replace(/^[a-z]\s+(?=(?:who|what|when|where|why|how|which|whom|whose|whether|okay|ok|yeah|yep|right|how's|what's|where's)\b)/i, '');
  // generic single-char noise like "h one sentence okay ?" -> "one sentence okay?" (last char duplication)
  // strip leading single consonant (not I/A) when followed by a word
  if (/^[b-hj-zB-HJ-Z]\s+\w/.test(s) && s.split(/\s+/).length >= 2) {
    // don't strip legitimate "A one..." but strip noise "h one..."
    // check that second word is not single char and s length >3
    const parts = s.split(/\s+/);
    if (parts[0].length === 1 && parts[1].length >= 2) {
      s = s.replace(/^[a-z]\s+/i, '');
    }
  }
  s = s.replace(/\b(you)estion\b/gi, '$1');
  s = s.replace(/\b(how)estion\b/gi, '$1');
  s = s.replace(/\b(what)estion\b/gi, '$1');
  // normalize space before punctuation ("where ?" -> "where?")
  s = s.replace(/\s+([?!.])/g, '$1');
  return s;
}

// Heuristic: is the clause a question starter? (used for comma-split)
const RE_Q_START = /^(who|what|when|where|why|how|which|whom|whose|whether|what's|how's|where's|when's|who's|why's|is|are|was|were|am|be|been|being|do|does|did|can|could|will|would|shall|should|may|might|must|have|has|had|ought|need|dare|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|cannot|won't|wouldn't|shouldn't|hasn't|haven't|hadn't)\b/i;
const RE_DECLARATIVE_START = /^(i'm|i am|i was|my name|i was born|today|now|then|here|my|our|your|i've|we're|they're|i)\b/i;
function isNoiseUtterance(s) {
  const t = s.trim();
  if (!t) return true;
  if (t.length <= 1) return true;
  if (/^[a-z]$/i.test(t)) return true;
  if (/^[a-z]\s*$/i.test(t)) return true;
  const parts = t.split(/\s+/);
  if (parts.length === 1 && t.length <= 2) return true;
  // all single-char tokens like "S S" or "e e"
  if (parts.length >= 1 && parts.every((w) => w.length === 1)) return true;
  // all tokens are single char or <=2 with no vowel? e.g. "S S"
  if (parts.length <= 3 && parts.join('').length <= 3 && !/[aeiou]/i.test(t)) return true;
  return false;
}
function findQuestionDeclarativeSplit(seg) {
  const words = seg.split(/\s+/);
  if (words.length < 4) return -1;
  const segWords = seg.split(/\s+/);
  const charPos = [0];
  let p = 0;
  for (let wi = 0; wi < segWords.length; wi++) {
    p += segWords[wi].length + 1;
    charPos.push(p);
  }
  for (let i = 3; i <= words.length - 2; i++) {
    const left = words.slice(0, i).join(' ');
    const right = words.slice(i).join(' ');
    if (left.split(/\s+/).length < 3 || right.split(/\s+/).length < 2) continue;
    const leftIsQ = RE_Q_START.test(left);
    if (!leftIsQ) continue;
    if (!RE_DECLARATIVE_START.test(right)) continue;
    // earliest valid split
    return charPos[i];
  }
  return -1;
}

/**
 * Pure: split block into utterances — no side effects, validated, Safari fallback.
 * @param {unknown} text
 * @returns {string[]}
 */
export function splitIntoUtterances(text) {
  const trimmed = normalizeInput(String(text || '').trim());
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

  // iterative splitting per seg to handle multiple questions in one block
  const out = [];
  for (const seg of merged) {
    // queue for iterative splitting
    const queue = [seg];
    const segOut = [];
    while (queue.length) {
      const cur = queue.shift();
      // Priority 1: question -> declarative boundary (e.g. "what's your name my name is Esther")
      const qdIdx = findQuestionDeclarativeSplit(cur);
      if (qdIdx > 0) {
        let left = cur.slice(0, qdIdx).trim().replace(/,\s*$/, '');
        const right = cur.slice(qdIdx).trim().replace(/^,\s*/, '');
        if (left && right && right.split(/\s+/).length >= 2 && left.split(/\s+/).length >= 2) {
          queue.unshift(right);
          segOut.push(left);
          continue;
        }
      }
      const lower = cur.toLowerCase();
      let splitPos = -1;
      let splitWord = '';
      for (const word of STRONG_SPLIT_WORDS) {
        const re = new RegExp(`\\b${word}\\b`, 'i');
        const m = re.exec(cur);
        if (m && m.index > 0) {
          const prefix = cur.slice(0, m.index).trim();
          const prefixWords = prefix ? prefix.split(/\s+/).length : 0;
          if (prefixWords >= MIN_PREFIX_WORDS) {
            if (splitPos === -1 || m.index < splitPos) {
              splitPos = m.index;
              splitWord = word;
            }
          }
        }
      }
      if (splitPos === -1) {
        for (const w of ['hows', 'whats', 'wheres', 'whos']) {
          const idx = lower.indexOf(w + ' ');
          if (idx > 0) {
            const prefix = cur.slice(0, idx).trim();
            if (prefix.split(/\s+/).length >= MIN_PREFIX_WORDS) { splitPos = idx; break; }
          }
        }
      }
      // Fast-speech comma-concat: "How are you, Today I will..."
      if (splitPos === -1 && cur.includes(',')) {
        const cIdx = cur.indexOf(',');
        const left = cur.slice(0, cIdx).trim();
        const right = cur.slice(cIdx + 1).trim();
        const leftWords = left ? left.split(/\s+/).length : 0;
        const rightWords = right ? right.split(/\s+/).length : 0;
        if (leftWords >= 2 && leftWords <= 12 && rightWords >= 2) {
          const leftIsQ = RE_Q_START.test(left) || /\b(how are you|what do you|where are you)\b/i.test(left);
          if (leftIsQ && /^[A-Z]/i.test(right)) {
            // split at comma
            queue.unshift(right);
            segOut.push(left);
            continue;
          }
        }
      }
      if (splitPos > 0) {
        const left = cur.slice(0, splitPos).trim();
        const right = cur.slice(splitPos).trim();
        if (left && right && right.split(/\s+/).length >= 2) {
          // push right back to queue for further splitting
          queue.unshift(right);
          segOut.push(left);
        } else {
          segOut.push(cur);
        }
      } else {
        segOut.push(cur);
      }
    }
    // filter noise utterances per segOut and push to out
    for (const s of segOut) {
      if (!isNoiseUtterance(s)) out.push(s);
      else if (s.trim().length >= 3) {
        // keep if length >=3 even if single char noise? but isNoise already true for len<=2
        // so skip
      }
    }
  }
  return out.filter(Boolean);
}

// Export internals for testing
export const _internals = { SENT_END_RE, STRONG_SPLIT_WORDS, MIN_PREFIX_WORDS };
