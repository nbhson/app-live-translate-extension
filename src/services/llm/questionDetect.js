/**
 * AI question detection — extract 1..N questions from a single utterance block.
 * Prompt is narrow, JSON-only, validated. Used as supplement to local isQuestion/split.
 * @module services/llm/questionDetect
 */
import { sanitizePromptContext } from '../../utils/sanitizePromptContext.js';
import { isQuestion } from '../../utils/isQuestion.js';

export function buildDetectPrompt(text) {
  const safe = sanitizePromptContext(String(text || '').slice(0, 800));
  // keep prompt short to save tokens: ~80 + safe length
  const prompt = `You are a question extractor for live English meeting transcripts.

Task: Given a transcript block, extract all distinct questions. Return JSON only.

Input block: """${safe}"""

Rules:
- Split on missing punctuation too (e.g. "Where are you from where were you born" -> 2 questions).
- Extract ONLY the question part, exclude declarative statements. Example: "Four of us do you have any siblings" -> ["do you have any siblings"] (exclude "Four of us").
- Keep each question as a complete sentence (3-20 words), without trailing "?".
- If block has no question, return empty array.
- If block has 1 question, return array with 1 element.
- If block has 2-4 questions, return each as separate element.
- Do NOT hallucinate: only use words from input block.

Output ONLY JSON: {"questions":["question 1","question 2"]}`;
  const systemPrompt = 'You are a precise question extractor. Output ONLY JSON with "questions" array. No markdown.';
  return { prompt, systemPrompt };
}

export function parseDetectResponse(raw) {
  if (!raw || typeof raw !== 'string') return [];
  let s = raw.trim();
  // strip fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      const obj = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
      if (obj && Array.isArray(obj.questions)) {
        return obj.questions
          .slice(0, 4)
          .map((q) => String(q).trim())
          .filter((q) => q.length >= 5 && q.length <= 200)
          .map((q) => q.replace(/\s+/g, ' ').trim());
      }
      if (Array.isArray(obj)) {
        return obj.slice(0, 4).map((q) => String(q).trim()).filter(Boolean);
      }
    }
  } catch (_) {}
  // fallback: try bare array
  try {
    const m2 = s.match(/\[[\s\S]*\]/);
    if (m2) {
      const arr = JSON.parse(m2[0].replace(/,\s*([}\]])/g, '$1'));
      if (Array.isArray(arr)) return arr.slice(0, 4).map((q) => String(q).trim()).filter(Boolean);
    }
  } catch (_) {}
  return [];
}

/**
 * Validate AI questions against original text to avoid hallucination.
 * @param {string} original
 * @param {string[]} questions
 * @returns {string[]}
 */
export function validateAiQuestions(original, questions) {
  if (!Array.isArray(questions) || questions.length === 0) return [];
  const origLower = String(original || '').toLowerCase();
  const origWords = new Set(origLower.split(/\s+/).filter(Boolean));
  const out = [];
  for (const q of questions) {
    const t = String(q).trim();
    if (!t || t.length < 5) continue;
    if (t.length > 250) continue;
    // must be a plausible question (avoid declarative fragments like "Four of us")
    if (!isQuestion(t) && t.split(/\s+/).filter(Boolean).length < 6) {
      // allow longer declarative-like fragments only if they clearly contain question pattern
      // e.g. "do you have any siblings" isQuestion true, but "Four of us" false -> skip
      if (!/\b(do you|are you|is there|can you|could you|will you|have you|where|what|how|who|when|why)\b/i.test(t)) continue;
    }
    // each question should share at least 50% words with original to avoid hallucination
    const qWords = t.toLowerCase().split(/\s+/).filter(Boolean);
    let hit = 0;
    for (const w of qWords) if (origWords.has(w)) hit++;
    if (qWords.length >= 3 && hit / qWords.length < 0.5) continue;
    if (out.includes(t)) continue;
    out.push(t);
  }
  // Filter out non-question fragments when we have at least one real question
  const hasRealQ = out.some((q) => isQuestion(q));
  let filtered = hasRealQ ? out.filter((q) => isQuestion(q) || q.split(/\s+/).length >= 5) : out;
  // if multiple, ensure combined length roughly matches original (allow 30% diff, looser for declarative+question extraction)
  if (filtered.length >= 2) {
    const joinedLen = filtered.join(' ').length;
    const origLen = String(original).trim().length;
    if (joinedLen < origLen * 0.4 || joinedLen > origLen * 1.5) {
      // suspicious hallucination / missing content
      // keep single best question instead of dropping all
      const best = filtered.find((q) => isQuestion(q));
      return best ? [best] : [];
    }
  }
  // Single question extraction: if AI extracted a shorter question from declarative+question block, keep it
  // e.g. original "Four of us do you have any siblings" -> ["do you have any siblings"] is valid
  if (filtered.length === 1 && String(original).trim().length > filtered[0].length + 8) {
    // ensure the single question is actually a question
    if (!isQuestion(filtered[0])) return [];
  }
  return filtered.slice(0, 4);
}

/**
 * Call LLM to detect questions — injectable for tests.
 * @param {string} text
 * @param {{baseUrl:string,model:string,apiKey:string}} providerConfig
 * @param {(prompt:string,cfg:any,opts:any)=>Promise<string>} callGeneric
 * @returns {Promise<string[]>}
 */
export async function detectQuestionsViaAI(text, providerConfig, callGeneric) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (!providerConfig || !providerConfig.baseUrl || !providerConfig.model) return [];
  const isLocal = String(providerConfig.baseUrl).includes('localhost') || String(providerConfig.baseUrl).includes('127.0.0.1');
  if (!providerConfig.apiKey && !isLocal) return [];
  const { prompt, systemPrompt } = buildDetectPrompt(t);
  const raw = await callGeneric(prompt, providerConfig, { temperature: 0.2, maxTokens: 256, systemPrompt });
  const parsed = parseDetectResponse(raw);
  return validateAiQuestions(t, parsed);
}
