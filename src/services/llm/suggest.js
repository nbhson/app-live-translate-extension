/**
 * Suggest orchestrator — cache, dedup, streaming, fallback, repair
 * @module services/llm/suggest
 */
import { buildSuggestPrompt } from '../../utils/buildSuggestPrompt.js';
import { parseSuggestAnswers, synthesizeStructures } from '../../utils/parseSuggestAnswers.js';
import { callProviderForSuggest } from './provider.js';
import { suggestCache, hashForSuggest } from './suggestCache.js';

export async function getSuggestForQuestion(question, contextEn, providerConfig, opts = {}) {
  const { compressEnabled, compressedSummary, suggestContextPrompt, quality } = opts;
  const ctxTail = Array.isArray(contextEn) ? contextEn.slice(-4).join('|').slice(-300) : '';
  const hash = hashForSuggest(question, ctxTail + (suggestContextPrompt || '').slice(-100));

  const cached = suggestCache.get(hash);
  if (cached) return cached;

  const inflight = suggestCache.getInFlight(hash);
  if (inflight) return inflight;

  const prompt = buildSuggestPrompt(question, contextEn, { compressEnabled, compressedSummary, suggestContextPrompt, quality: quality || 'fast' });

  // onChunk for streaming UI — opts.onChunk receives partial acc
  const promise = (async () => {
    const raw = await callProviderForSuggest(prompt, providerConfig, {
      timeout: opts.timeout,
      signal: opts.signal,
      quality: quality || 'fast',
      stream: true,
      onChunk: opts.onChunk,
    });
    let parsed = parseSuggestAnswers(raw);
    let { structures, answers } = parsed;
    // repair: if empty, try lenient + synthesize
    answers = (answers || []).filter(a => !(a.trim().startsWith('{') && /"structures"|"answers"/.test(a)));
    structures = (structures || []).filter(s => !(s.trim().startsWith('{') && /"structures"|"answers"/.test(s)));
    answers = answers.filter(a => !(a.includes(' + ') && a.split(/\s+/).length < 15));
    const isSubstantial = (a) => a.length >= 40 && a.split(/\s+/).length >= 8;
    const substantial = answers.filter(isSubstantial);
    if (substantial.length > 0) answers = substantial;
    else if (answers.length > 0 && answers.every(a => a.length < 40)) answers = [];

    if (answers.length === 0 && structures.length === 0) throw new Error('Failed to parse suggestions');
    if (structures.length === 0 && answers.length > 0) structures = synthesizeStructures(answers);
    answers = answers.slice(0, 3);
    structures = structures.slice(0, 3);
    const result = { structures, answers, raw };
    suggestCache.set(hash, result);
    return result;
  })();

  suggestCache.setInFlight(hash, promise);
  return promise;
}
