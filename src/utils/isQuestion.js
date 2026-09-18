// Hoisted regexes — compiled once, pure
const RE_WH_START = /^(who|what|when|where|why|how|which|whom|whose|whether|what's|how's|where's|when's|who's|why's)\b/i;
const RE_AUX_START = /^(is|are|was|were|am|be|been|being|do|does|did|can|could|will|would|shall|should|may|might|must|have|has|had|ought|need|dare|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|cannot|won't|wouldn't|shouldn't|hasn't|haven't|hadn't|is there|are there|was there|were there|have there|has there|what's|how's|where's|who's)\b/i;
const RE_TAG_Q = /,\s*(right|correct|isn't it|aren't you|don't you|doesn't it|doesn't he|doesn't she|didn't you|won't you|wouldn't you|haven't you|hasn't he|is it|are you|wasn't it|weren't you|okay|ok|yeah|yep|huh)\s*\??\s*$/i;
const RE_EMBEDDED = /\b(do you|does he|does she|do they|did you|did he|did she|are you|is he|is she|are they|is there|are there|was there|were there|can you|could you|would you|will you|shall we|should you|should we|have you|has he|has she|had you|am i|would you mind|could you please|can you please|will you please|do you know|do you think|have you ever|would you like|could you tell|can you tell|are you going|is he going|will you be|have you been|has anyone|did anyone|did you ever|could you kindly|would you kindly)\b/i;
const RE_INDIRECT = /^(do you know|can you tell|would you mind|could you explain|have you ever|are you familiar|do you think|would you say|is there any|are there any|tell me|let me know|any idea|anyone know|anybody know|everyone know|any chance|could you share|would you happen)\b/i;
const RE_TRAILING_OR = /\b(or not|or what|or something|or anything|or somewhere)\s*$/i;
const RE_DECLARATIVE_FALSE = /^(this|that|these|those|it|we|they|he|she|you)\s+(is|are|was|were|have|has|had|will|would|can|could|should)\b/i;

/**
 * Detect question — multi-layer + optional compromise, pure-ish, hoisted regex, validated.
 * @param {unknown} text
 * @param {{ nlp?: Function }} opts — inject compromise nlp for testability; defaults to window/self
 * @returns {boolean}
 */
export function isQuestion(text, opts = {}) {
  const raw = (text || '').trim();
  if (!raw) return false;
  if (raw.length < 3) return false;
  if (raw.includes('?')) return true;

  const t = raw.replace(/\s+/g, ' ').trim();
  const lower = t.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const wc = words.length;
  if (wc < 2) return false;

  // Library first (if loaded): compromise
  try {
    const nlpFn = opts.nlp
      || (typeof window !== 'undefined' && window.nlp)
      || (typeof self !== 'undefined' && self.nlp)
      || null;
    if (typeof nlpFn === 'function') {
      const doc = nlpFn(t);
      if (doc && typeof doc.questions === 'function') {
        const qs = doc.questions();
        if (qs && qs.found) return true;
        if (qs && typeof qs.length === 'number' && qs.length > 0) return true;
      }
    }
  } catch (_) {}

  // Exclamation exclusion narrower — only true exclamations not questions
  if (t.endsWith('!')) {
    if (/^what\s+a(n)?\b/i.test(t)) return false;
    if (/^how\s+(wonderful|nice|great|beautiful|amazing|lovely|good|bad|terrible).*!\s*$/i.test(t)) return false;
    // "What a question!" vs "What time is it!" — latter missing ? due to speech, keep true
    if (/^what\s+a\b/.test(t)) return false;
  }

  // Declarative trap: "This is correct." starts with This but not question
  const startsDeclarative = RE_DECLARATIVE_FALSE.test(t) && !RE_TAG_Q.test(t) && !RE_TRAILING_OR.test(t) && !RE_EMBEDDED.test(t);
  if (startsDeclarative && !RE_WH_START.test(t) && !RE_AUX_START.test(t)) return false;

  if (RE_WH_START.test(t)) {
    // contractions like "what's" count as WH
    if (wc >= 2 && !t.endsWith('!')) return true;
  }
  if (RE_AUX_START.test(t) && wc >= 2) return true;
  if (RE_TAG_Q.test(t)) return true;
  if (RE_EMBEDDED.test(t) && wc >= 4) return true;
  if (RE_INDIRECT.test(lower) && wc >= 3) return true;
  if (RE_TRAILING_OR.test(t) && wc >= 4) return true;
  return false;
}
