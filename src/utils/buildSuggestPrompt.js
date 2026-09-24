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

  // v2 fast prompt: tighter budget, JSON mode friendly, ~30% fewer tokens
  // opts.quality: 'fast' (40-70 words, 2-3 sentences, ~500 tokens) vs 'quality' (60-120 words)
  const isFast = opts.quality === 'fast';
  const wordsSpec = isFast ? '40-70 words' : '60-120 words';
  const sentSpec = isFast ? '2-3 sentences' : '3-5 sentences';
  const maxCtx = isFast ? 2500 : 3500;
  const recentBudget = isFast ? 1000 : 1500;

  if (compressEnabled && compressedSummary) {
    const recent = ctxArr.slice(-CONFIG.COMPRESS_RECENT_KEEP);
    const recentCtx = truncateForPrompt(recent, recentBudget);
    const comp = compressedSummary.length > CONFIG.COMPRESS_MAX_CHARS
      ? compressedSummary.slice(-CONFIG.COMPRESS_MAX_CHARS)
      : compressedSummary;
    return `You are a bilingual EN->VI meeting assistant. Generate quick English answers.

${contextHint}History: """${comp}"""
Recent (${recent.length}): """${recentCtx}"""
Q: """${q}"""

Return JSON ONLY: {"structures":["3-7 words hint x3"],"answers":["${sentSpec}, ${wordsSpec} paragraph x3, diverse tones, conversational"]}
Rules: 3 structures + 3 answers, consistent with history${contextHint ? '+context' : ''}, placeholder [City, Country] if location Q. No markdown.`;
  }

  const ctx = truncateForPrompt(ctxArr, maxCtx);
  return `You are a bilingual EN->VI meeting assistant. Generate quick English answers.

${contextHint}History: """${ctx}"""
Q: """${q}"""

Return JSON ONLY: {"structures":["3-7 words hint x3"],"answers":["${sentSpec}, ${wordsSpec} paragraph x3, diverse tones, conversational"]}
Rules: 3 structures + 3 answers, consistent with history. No markdown.`;
}
