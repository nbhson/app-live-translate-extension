import { CONFIG } from '../config.js';
import { sanitizePromptContext } from './sanitizePromptContext.js';

function truncateForPrompt(arr, maxChars) {
  const joined = arr.join(' | ');
  if (joined.length <= maxChars) return joined;
  // keep tail (most recent) when over limit
  return joined.slice(-maxChars);
}

/**
 * Build LLM prompt for suggested answers.
 * Pure - no side effects, validated inputs, no prompt injection.
 * @param {string} question
 * @param {string[]} contextEn
 * @param {{ compressEnabled?: boolean, compressedSummary?: string, suggestContextPrompt?: string }} opts
 * @returns {string}
 */
export function buildSuggestPrompt(question, contextEn, opts = {}) {
  const { compressEnabled = false, compressedSummary = '', suggestContextPrompt = '' } = opts;
  const q = String(question || '').trim();
  const ctxArr = Array.isArray(contextEn) ? contextEn.filter((s) => typeof s === 'string') : [];
  const contextHint = suggestContextPrompt && String(suggestContextPrompt).trim()
    ? `User-provided context (use to tailor tone/style/domain of answers): """${sanitizePromptContext(suggestContextPrompt)}"""\n\n`
    : '';

  if (compressEnabled && compressedSummary) {
    const recent = ctxArr.slice(-CONFIG.COMPRESS_RECENT_KEEP);
    // ensure recent context fits prompt budget — truncate tail
    const recentCtx = truncateForPrompt(recent, 1500);
    const comp = compressedSummary.length > CONFIG.COMPRESS_MAX_CHARS
      ? compressedSummary.slice(-CONFIG.COMPRESS_MAX_CHARS)
      : compressedSummary;
    return `You are a helpful assistant for a bilingual EN->VI meeting. The user just heard an English question and needs quick suggested answers in English (natural, conversational, polite).

${contextHint}Compressed history (older, summarized every 5 min): """${comp}"""

Recent conversation (latest ${recent.length} utterances): """${recentCtx}"""

Question: """${q}"""

Task: Use BOTH compressed history, recent conversation${contextHint ? ' and user-provided context' : ''} to generate context-aware answers. Return JSON with two fields:
- "structures": 3 short structure hints (3-7 words each, like "Friendly response + acknowledge shared origin + light detail")
- "answers": 3 full natural answers in English (each 3-5 sentences, 60-120 words, diverse angles: friendly / detailed / concise etc, each may contain placeholder [City, Country] if location question). Each answer must be a short paragraph of 3-5 complete sentences, natural and conversational. Answers MUST be consistent with the history${contextHint ? ' and the user-provided context' : ''}.

Output ONLY JSON object, e.g. {"structures":["Hint 1","Hint 2","Hint 3"],"answers":["Answer 1 paragraph with 3-5 sentences...","Answer 2 paragraph...","Answer 3 paragraph..."]}. No markdown, no extra text.`;
  }

  const ctx = truncateForPrompt(ctxArr.slice(-4), 1000);
  return `You are a helpful assistant for a bilingual EN->VI meeting. The user just heard an English question and needs quick suggested answers in English (natural, conversational, polite).

${contextHint}Context (last utterances): """${ctx}"""

Question: """${q}"""

Task: Return JSON with two fields:
- "structures": 3 short structure hints (3-7 words each, like "Friendly response + acknowledge shared origin + light detail")
- "answers": 3 full natural answers in English (each 3-5 sentences, 60-120 words, diverse angles: friendly / detailed / concise etc, each may contain placeholder [City, Country] if location question). Each answer must be a short paragraph of 3-5 complete sentences, natural and conversational.${contextHint ? '\nTailor answers to the user-provided context above.' : ''}

Output ONLY JSON object, e.g. {"structures":["Hint 1","Hint 2","Hint 3"],"answers":["Answer 1 paragraph with 3-5 sentences...","Answer 2 paragraph...","Answer 3 paragraph..."]}. No markdown, no extra text.`;
}
