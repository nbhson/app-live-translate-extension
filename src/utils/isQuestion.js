// Hoisted regexes — compiled once, pure
const RE_WH_START = /^(who|what|when|where|why|how|which|whom|whose|whether|what's|how's|where's|when's|who's|why's)\b/i;
const RE_WH_ABOUT = /^(what about|how about)\b/i;
const RE_CASUAL_Q = /^(wanna|lemme|gimme|dunno)\b/i;
const RE_AUX_START = /^(is|are|was|were|am|be|been|being|do|does|did|can|could|will|would|shall|should|may|might|must|have|has|had|ought|need|dare|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|cannot|won't|wouldn't|shouldn't|hasn't|haven't|hadn't|is there|are there|was there|were there|have there|has there|what's|how's|where's|who's)\b/i;
const RE_TAG_Q = /,\s*(right|correct|isn't it|aren't you|don't you|doesn't it|doesn't he|doesn't she|didn't you|won't you|wouldn't you|haven't you|hasn't he|is it|are you|wasn't it|weren't you|okay|ok|yeah|yep|huh)\s*\??\s*$/i;
const RE_TAG_Q_NOCOMMA = /\b(right|okay|ok|yeah|yep|huh)\s*\??\s*$/i;
const RE_EMBEDDED = /\b(do you|does he|does she|do they|did you|did he|did she|are you|is he|is she|are they|is there|are there|was there|were there|can you|could you|would you|will you|shall we|should you|should we|have you|has he|has she|had you|am i|would you mind|could you please|can you please|will you please|do you know|do you think|have you ever|would you like|could you tell|can you tell|are you going|is he going|will you be|have you been|has anyone|did anyone|did you ever|could you kindly|would you kindly|how are you|how is it|what do you|where are you|when are you|why are you|who are you)\b/i;
const RE_INDIRECT = /^(do you know|can you tell|would you mind|could you explain|have you ever|are you familiar|do you think|would you say|is there any|are there any|tell me|let me know|any idea|anyone know|anybody know|everyone know|any chance|could you share|would you happen|i was wondering if|wondering if|any chance you could|is there a chance)\b/i;
const RE_WONDERING = /\b(i was wondering if|i wonder if|wondering if|do you mind if|would you mind if)\b/i;
const RE_POLITE = /\b(could you maybe|would you maybe|could you kindly|would you kindly|would you please|could you please|would you be able to|could you be able to|could you just|would you just)\b/i;
const RE_TRAILING_OR = /\b(or not|or what|or something|or anything|or somewhere)\s*$/i;
const RE_DECLARATIVE_FALSE = /^(this|that|these|those|it|we|they|he|she|you)\s+(is|are|was|were|have|has|had|will|would|can|could|should)\b/i;

// STT noise normalizer — strip leading single-char artifacts ("s How are you" -> "How are you")
// and fused suffixes ("youestion" -> "you") from fast speech.
function normalizeForQuestion(raw) {
  let s = String(raw || '').trim();
  // strip leading single char prefix before WH/tag
  s = s.replace(/^[a-z]\s+(?=(?:who|what|when|where|why|how|which|whom|whose|whether|okay|ok|yeah|yep|right|how's|what's|where's)\b)/i, '');
  // generic single-char noise like "h one..." / "o success..."
  if (/^[a-z]\s+\w/i.test(s) && !/^[IA]\s/i.test(s) && s.split(/\s+/).length >= 2) {
    const parts = s.split(/\s+/);
    if (parts[0].length === 1 && parts[1].length >= 2) s = s.replace(/^[a-z]\s+/i, '');
  }
  // fix fused "you"+"estion" / "how"+"estion" artifacts from fast speech
  s = s.replace(/\b(you)estion\b/gi, '$1');
  s = s.replace(/\b(how)estion\b/gi, '$1');
  s = s.replace(/\b(what)estion\b/gi, '$1');
  // expand casual speech: wanna -> want to, gonna -> going to, lemme -> let me
  s = s.replace(/\bwanna\b/gi, 'want to');
  s = s.replace(/\bgonna\b/gi, 'going to');
  s = s.replace(/\bgotta\b/gi, 'got to');
  s = s.replace(/\blemme\b/gi, 'let me');
  s = s.replace(/\bgimme\b/gi, 'give me');
  // collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Detect question — multi-layer + optional compromise, pure-ish, hoisted regex, validated.
 * @param {unknown} text
 * @param {{ nlp?: Function }} opts — inject compromise nlp for testability; defaults to window/self
 * @returns {boolean}
 */
export function isQuestion(text, opts = {}) {
  const rawIn = (text || '').trim();
  if (!rawIn) return false;
  if (rawIn.length < 3) return false;
  if (rawIn.includes('?')) return true;
  // casual wanna/lemme before STT expansion (wanna -> want to)
  if (RE_CASUAL_Q.test(rawIn.trim())) return true;

  const raw = normalizeForQuestion(rawIn);
  if (raw.includes('?')) return true;
  if (!raw || raw.length < 3) return false;

  const t = raw.replace(/\s+/g, ' ').trim();
  const lower = t.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const wc = words.length;
  if (wc < 2) return false;
  // incomplete fragment ending with preposition/article — wait for next chunk
  if (/\b(to|for|with|of|in|on|at|a|an|the)\s*$/i.test(t)) return false;

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

  // Fast-speech comma-concat: "How are you, Today I will..." -> check leading question clause before comma
  const commaIdx = t.indexOf(',');
  if (commaIdx > 0) {
    const left = t.slice(0, commaIdx).trim();
    const leftWords = left.split(/\s+/).filter(Boolean).length;
    if (leftWords >= 2 && leftWords <= 12) {
      const leftLower = left.toLowerCase();
      // if left clause itself is a question, whole utterance is question
      if (RE_WH_START.test(left) || RE_AUX_START.test(left) || RE_EMBEDDED.test(leftLower) || RE_TAG_Q.test(left)) {
        // ensure right side is declarative-like (capital start) to avoid false on enumeration commas
        const right = t.slice(commaIdx + 1).trim();
        if (right && /^[A-Z]/.test(right)) return true;
        // even without capital, if left is strong WH/AUX, treat as question
        if (RE_WH_START.test(left) || RE_AUX_START.test(left)) return true;
      }
    }
  }

  // Helper: no-comma tag check with adjective guard (avoid "you are right" declarative)
  function isNoCommaTag(s, wordCount) {
    if (!RE_TAG_Q_NOCOMMA.test(s) || wordCount < 3) return false;
    // "I think you are right" -> ends with "are right" as adjective, not tag
    if (/\b(are|is|was|were)\s+right\s*\??\s*$/i.test(s) && !/,\s*right\s*\??\s*$/i.test(s)) {
      // allow "You are coming right" (verb+right as tag) but block "are right" adjective
      // if word before "are right" is pronoun-think pattern, treat as declarative
      if (/^(i think|you are|he is|she is|it is|we are|they are)\b/i.test(s.trim()) || /\bthink\s+you\s+are\s+right\s*$/i.test(s)) return false;
      // generic: if sentence is short and is "X is/are right" treat as declarative only if no comma
      if (/^\w+\s+(is|are|was|were)\s+right\s*$/i.test(s.trim())) return false;
    }
    if (/^this\s+is\s+correct\s*$/i.test(s) || /^that\s+is\s+correct\s*$/i.test(s)) return false;
    return true;
  }
  // Declarative trap: "This is correct." starts with This but not question
  // Check both comma and no-comma tag variants to avoid false on "This is correct"
  const hasTag = RE_TAG_Q.test(t) || isNoCommaTag(t, wc);
  const startsDeclarative = RE_DECLARATIVE_FALSE.test(t) && !hasTag && !RE_TRAILING_OR.test(t) && !RE_EMBEDDED.test(t);
  if (startsDeclarative && !RE_WH_START.test(t) && !RE_AUX_START.test(t)) return false;

  if (RE_WH_ABOUT.test(t) && wc >= 2 && !t.endsWith('!')) return true;
  if (RE_CASUAL_Q.test(t) && wc >= 2) return true;
  if (RE_WH_START.test(t)) {
    // contractions like "what's" count as WH
    if (wc >= 2 && !t.endsWith('!')) return true;
  }
  if (RE_AUX_START.test(t) && wc >= 2) return true;
  if (RE_TAG_Q.test(t)) return true;
  // tag without comma: only for short markers (right/okay/yeah...) and not declarative adjectives like "correct"
  if (isNoCommaTag(t, wc)) return true;
  if (RE_EMBEDDED.test(t) && wc >= 4) return true;
  if (RE_WONDERING.test(t) && wc >= 4) return true;
  if (RE_POLITE.test(t) && wc >= 4) return true;
  if (RE_INDIRECT.test(lower) && wc >= 3) return true;
  if (RE_TRAILING_OR.test(t) && wc >= 4) return true;
  return false;
}
