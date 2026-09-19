/**
 * Compression Agent — single-shot agent (LLM + harness tools) for history compression.
 *
 * WHY AGENT (not just prompt)?
 * Original compress: hardcoded "summarize segment → 3-5 bullets" in one LLM call.
 * Agent version: harness pre-fetches tools (compressedHistory, pendingSegment, recentQuestions)
 * and builds a QA-aware prompt so the compressed output preserves info useful for
 * future answer suggestions. No ReAct loop needed — compression is deterministic
 * single-turn; loop would add latency without benefit.
 *
 * If provider supports function-calling, we could make it multi-turn (LLM calls tools
 * on demand), but current flow is single-shot with tool data baked into prompt.
 * The architecture (toolDefs + execute) is ready for loop when needed.
 *
 * @module harness/agent/compression.agent
 */
import { callProviderGeneric } from '../../services/llm/provider.js';
import { gatherCompressionContext } from './tools.js';
import { buildCompressPrompt, isValidCompressSummary } from '../../utils/buildCompressPrompt.js';

export function createCompressionAgent({ store, llmHarness } = {}) {
  const _store = store;
  const _llm = llmHarness;

  return {
    /**
     * Run compression as agent — harness gathers tools, LLM produces QA-aware summary.
     * @param {{ segment: string, pendingCount: number, providerConfig: object }} params
     * @returns {Promise<string>} cleaned summary bullets
     */
    async run({ segment, pendingCount, providerConfig }) {
      // Gather tool context (harness tools)
      const ctx = await gatherCompressionContext({ store: _store });
      const recentQs = ctx.questions.questions.map((q) => q.question);
      const { prompt, systemPrompt } = buildCompressPrompt({
        segment,
        pendingCount,
        compressedSummary: ctx.history.compressedSummary || '',
        recentQuestions: recentQs,
      });

      // Use harness llm (with retry/timeout) — single shot, no loop needed for compression
      const raw = _llm
        ? await _llm.callGeneric(prompt, providerConfig, { temperature: 0.3, maxTokens: 320, systemPrompt })
        : await callProviderGeneric(prompt, providerConfig, { temperature: 0.3, maxTokens: 320, systemPrompt });

      return String(raw || '').trim();
    },

    /**
     * Validate agent output — must be non-empty bullets
     * @param {string} summary
     * @returns {boolean}
     */
    isValid(summary) {
      return isValidCompressSummary(summary);
    },
  };
}
