/**
 * Heuristic gate for AI question detect — only call LLM when local rules are uncertain.
 * Keeps offline/fast path, limits cost/latency to ~5-10% utterances.
 * @module utils/shouldTriggerAiDetect
 */

const WH_RE = /\b(who|what|when|where|why|how|which|whom|whose|whether)\b/gi;
const AUX_RE = /\b(is|are|was|were|am|be|been|being|do|does|did|can|could|will|would|shall|should|may|might|must|have|has|had|ought|need|dare)\b/gi;

/**
 * Should trigger AI split for 1 utterance that likely contains 2+ questions?
 * @param {string} text
 * @returns {boolean}
 */
export function shouldTriggerAiSplit(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.length < 15) return false;
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  const termCount = (t.match(/[.!?]+/g) || []).length;
  if (termCount >= 2) return false;

  const lower = t.toLowerCase();
  const whCount = (lower.match(WH_RE) || []).length;
  const auxCount = (lower.match(AUX_RE) || []).length;
  if (whCount >= 2) return true;
  if (auxCount >= 2 && words.length >= 7) {
    if (auxCount >= 2) return true;
  }
  if (whCount >= 1 && auxCount >= 1 && words.length >= 8) {
    const markers = [];
    const re = /\b(who|what|when|where|why|how|which|is|are|was|were|am|do|does|did|can|could|will|would|shall|should|have|has|had)\b/gi;
    let m;
    while ((m = re.exec(lower)) !== null) markers.push(m.index);
    if (markers.length >= 2) {
      if (markers[1] - markers[0] > 12) return true;
    }
  }
  // Declarative + question concat without second WH/AUX count: e.g. "Four of us do you have any siblings"
  // Heuristic: utterance contains embedded question phrase not at start
  if (words.length >= 6) {
    const emb = lower.search(/\b(do you|does he|does she|do they|did you|are you|is he|is she|are they|is there|are there|can you|could you|will you|would you|have you|has anyone|how many|what is|where are|who are|which one)\b/i);
    if (emb > 12 && emb < lower.length - 10) {
      const prefixWords = lower.slice(0, emb).trim().split(/\s+/).filter(Boolean).length;
      const suffixWords = lower.slice(emb).trim().split(/\s+/).filter(Boolean).length;
      if (prefixWords >= 2 && suffixWords >= 3) return true;
    }
  }
  return false;
}

/**
 * Should trigger AI for suspected false-negative (local says not question but looks like one)?
 * Conservative to limit calls.
 * @param {string} text
 * @param {boolean} localIsQuestion
 * @returns {boolean}
 */
export function shouldTriggerAiFalseNegative(text, localIsQuestion) {
  if (localIsQuestion) return false;
  const t = String(text || '').trim();
  if (!t) return false;
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 5 || words.length > 22) return false;
  if (t.includes('?')) return false; // already question
  const lower = t.toLowerCase();
  // contains question-like phrase but local said false (e.g., declarative trap)
  if (/\b(wondering if|do you mind|any idea|any chance|tell me|let me know|anyone know)\b/i.test(t)) return true;
  // has trailing tag/or not without comma that local may miss
  if (/\b(or not|or what|right|okay|yeah|huh)\s*$/i.test(t) && words.length >= 4) return true;
  // long declarative with embedded inversion that local missed due to prefix guard
  if (words.length >= 6 && /\b(do you|are you|is there|can you|could you|would you|have you|has anyone)\b/i.test(lower)) return true;
  return false;
}

/**
 * Unified gate: should we call AI detect for this utterance?
 * @param {string} text
 * @param {boolean} localIsQuestion
 * @returns {boolean}
 */
export function shouldTriggerAiDetect(text, localIsQuestion) {
  if (shouldTriggerAiSplit(text)) return true;
  if (shouldTriggerAiFalseNegative(text, localIsQuestion)) return true;
  return false;
}
