import { sanitizePromptContext } from './sanitizePromptContext.js';

export function buildCompressPrompt({ segment, pendingCount, compressedSummary = '', recentQuestions = [] }) {
  const qs = Array.isArray(recentQuestions) ? recentQuestions.join(' | ') : String(recentQuestions || '');
  const recentQs = qs.trim() || '(none yet)';
  const existing = compressedSummary
    ? `\nExisting compressed history (keep continuity, don't duplicate):\n"""${sanitizePromptContext(compressedSummary.slice(-2000))}"""` : '';
  const safeSegment = sanitizePromptContext(String(segment || '').slice(-8000));
  const prompt = `You are a compression agent for a live EN→VI meeting that supports answering questions.

Goal: Compress the pending transcript segment into 3-5 bullet points (max 150 words, English) that PRESERVE information most useful for answering future questions. Prioritize: names, topics, decisions, questions asked, facts that could be referenced later.${existing}

Recent questions in this meeting (prioritize preserving context for similar future questions):
"""${sanitizePromptContext(recentQs)}"""

Pending segment to compress (${pendingCount} utterances):
"""${safeSegment}"""

Output ONLY bullet points (each starting with "- "), no intro, no extra text.`;
  const systemPrompt = 'You are a precise meeting compression agent. Output only bullet points useful for future QA.';
  return { prompt, systemPrompt };
}

export function isValidCompressSummary(summary) {
  if (!summary || typeof summary !== 'string') return false;
  const t = summary.trim();
  if (t.length < 20) return false;
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  // must contain at least 1 bullet line starting with "- " or "•" or "*"
  const bulletCount = lines.filter((l) => /^[-•*]\s+/.test(l)).length;
  if (bulletCount === 0) return false;
  // all non-empty lines should be reasonably long or bullet-like; reject garbage single-char
  if (t.length < 30 && bulletCount < 1) return false;
  return true;
}
