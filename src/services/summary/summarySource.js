/**
 * Summary source — pure helpers to assemble the FULL meeting text for AI summary.
 *
 * Root cause of "1h meeting only summarizes last 30m":
 * - `compactTranscriptState()` drops oldest utterances past the memory cap, and
 * - `generateSummary()` only read the live window (`finalizedEnPhrases`), ignoring
 *   both the dropped head and `compressedSummary`.
 *
 * New contract: keep an append-only `fullEnHistory` (every finalized utterance ever).
 * Summary input = fullEnHistory (preferred) + compressedSummary (early context for
 * legacy sessions compacted before this fix). Long meetings are split into chunks
 * (map) and merged (reduce) so no part is silently truncated.
 *
 * @module services/summary/summarySource
 */

/** Max transcript chars sent in a single LLM call (map step). ~12k chars ≈ 3k tokens. */
export const SUMMARY_CHUNK_CHARS = 12000;

/** Cap for the rolling compressed history (bullets). Covers ~2h of 5-min compressions. */
export const COMPRESSED_SUMMARY_MAX_CHARS = 15000;

/** Hard cap for the append-only full history (utterances). ~5000 ≈ 4-6h of speech. */
export const FULL_HISTORY_MAX_UTTERANCES = 5000;

/**
 * Append utterances to the append-only full history (no mutation of input).
 * Oldest entries are dropped only past FULL_HISTORY_MAX_UTTERANCES.
 * @param {string[]} history
 * @param {string[]} utterances
 * @returns {string[]}
 */
export function appendFullHistory(history, utterances) {
  const base = Array.isArray(history) ? history.slice() : [];
  const adds = Array.isArray(utterances) ? utterances.filter((u) => typeof u === 'string' && u.trim()) : [];
  const next = base.concat(adds);
  if (next.length > FULL_HISTORY_MAX_UTTERANCES) {
    return next.slice(next.length - FULL_HISTORY_MAX_UTTERANCES);
  }
  return next;
}

/**
 * Pick the authoritative utterance list for summary.
 * Prefers the append-only full history; falls back to the live window.
 * @param {{ fullHistory?: string[], livePhrases?: string[] }} src
 * @returns {string[]}
 */
export function pickSummaryUtterances(src) {
  const full = Array.isArray(src?.fullHistory) ? src.fullHistory.filter(Boolean) : [];
  if (full.length > 0) return full;
  const live = Array.isArray(src?.livePhrases) ? src.livePhrases.filter(Boolean) : [];
  return live;
}

/**
 * Split utterances into chronological chunks, each <= maxChars when joined.
 * A single oversized utterance becomes its own chunk (never dropped).
 * @param {string[]} utterances
 * @param {number} [maxChars]
 * @returns {string[][]}
 */
export function splitSummaryChunks(utterances, maxChars = SUMMARY_CHUNK_CHARS) {
  const list = Array.isArray(utterances) ? utterances.filter(Boolean) : [];
  const cap = Math.max(1000, Number(maxChars) || SUMMARY_CHUNK_CHARS);
  if (list.length === 0) return [];
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const u of list) {
    const add = u.length + 1; // + newline separator
    if (cur.length > 0 && curLen + add > cap) {
      chunks.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(u);
    curLen += add;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/**
 * Build the per-chunk (map) prompt. Chunk 0 also carries the early compressed
 * history so legacy-compacted heads are not lost.
 * @param {string} chunkText
 * @param {{ lang?: string, detail?: string, chunkIndex?: number, totalChunks?: number, compressedSummary?: string }} opts
 * @returns {string}
 */
export function buildChunkPrompt(chunkText, opts = {}) {
  const lang = opts.lang === 'vi' ? 'vi' : 'en';
  const detail = opts.detail || 'bullets';
  const idx = Number(opts.chunkIndex) || 0;
  const total = Math.max(1, Number(opts.totalChunks) || 1);
  const outLang = lang === 'vi' ? 'Vietnamese' : 'English';
  const early = typeof opts.compressedSummary === 'string' && opts.compressedSummary.trim() && idx === 0
    ? `Earlier part of this same meeting (already-compressed bullets, may overlap with the transcript below — deduplicate, prefer transcript details):\n"""\n${opts.compressedSummary.trim().slice(0, COMPRESSED_SUMMARY_MAX_CHARS)}\n"""\n\n`
    : '';
  let req = '';
  if (detail === 'bullets') {
    req = '- Format as detailed bullet points grouped by topics discussed in THIS part.\n- Keep names, numbers, decisions, questions raised.\n';
  } else if (detail === 'short') {
    req = '- Write a concise paragraph (max 5 sentences) covering this part\'s core topic and conclusions.\n';
  } else if (detail === 'action') {
    req = '- Extract Action Items from THIS part (who + deadline if mentioned). Empty list if none.\n';
  }
  const partLabel = total > 1 ? ` (part ${idx + 1}/${total}, chronological)` : '';
  return `You are a professional meeting assistant. Summarize this meeting transcript excerpt${partLabel} in **${outLang}**.\n\n${early}Transcript excerpt:\n"""\n${chunkText}\n"""\n\nRequirements:\n${req}- Output clean Markdown, no HTML.`;
}

/**
 * Build the merge (reduce) prompt from per-chunk summaries.
 * @param {string[]} chunkSummaries
 * @param {{ lang?: string, detail?: string }} opts
 * @returns {string}
 */
export function buildMergePrompt(chunkSummaries, opts = {}) {
  const lang = opts.lang === 'vi' ? 'vi' : 'en';
  const detail = opts.detail || 'bullets';
  const outLang = lang === 'vi' ? 'Vietnamese' : 'English';
  const parts = chunkSummaries
    .map((s, i) => `--- Part ${i + 1}/${chunkSummaries.length} summary ---\n${s}`)
    .join('\n\n');
  let req = '';
  if (detail === 'bullets') {
    req = '- Format as detailed bullet points grouped by topics or main parts discussed.\n- Highlight key arguments or points raised by participants.\n';
  } else if (detail === 'short') {
    req = '- Write a highly concise summary (max 2-3 short paragraphs) explaining the core topic and final conclusions.\n';
  } else if (detail === 'action') {
    req = '- Extract and list Action Items, including who is responsible (if mentioned) and deadlines (if mentioned).\n- Structure them clearly as a checklist or to-do list.\n';
  }
  return `You are a professional meeting assistant. Below are chronological per-part summaries of ONE meeting (part 1 = earliest).\n\n${parts}\n\nCombine them into a single coherent meeting summary in **${outLang}** covering the WHOLE meeting from start to finish (do not drop early parts):\n${req}- Format the output using clean Markdown, using headers (h2, h3) and bold text for emphasis. Do not use HTML.`;
}
