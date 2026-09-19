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
  // already has sentence punctuation -> local split already did it
  // but keep AI for cases like "Where are you from where were you born" (no ?)
  // if text already contains 2+ sentence terminators, not needed
  const termCount = (t.match(/[.!?]+/g) || []).length;
  if (termCount >= 2) return false;

  const lower = t.toLowerCase();
  const whCount = (lower.match(WH_RE) || []).length;
  const auxCount = (lower.match(AUX_RE) || []).length;
  // reset lastIndex for global regex
  // Two WH or two AUX in one utterance without ? is suspicious for Q->Q
  if (whCount >= 2) return true;
  if (auxCount >= 2 && words.length >= 7) {
    // avoid single question with aux+wh counted as 2 aux e.g. "What is your name" has is=1 aux, wh=1
    // need at least 2 aux distinct
    if (auxCount >= 2) return true;
  }
  // mixed: 1 WH + 1 AUX in long utterance (>=8 words) likely Q+Q like "What is your name can you tell me"
  if (whCount >= 1 && auxCount >= 1 && words.length >= 8) {
    // check that markers are not from single question: distance between first and second marker >=3 words
    // quick check: find positions
    const markers = [];
    const re = /\b(who|what|when|where|why|how|which|is|are|was|were|am|do|does|did|can|could|will|would|shall|should|have|has|had)\b/gi;
    let m;
    while ((m = re.exec(lower)) !== null) markers.push(m.index);
    if (markers.length >= 2) {
      // estimate word distance by char distance > ~12 chars
      if (markers[1] - markers[0] > 12) return true;
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
