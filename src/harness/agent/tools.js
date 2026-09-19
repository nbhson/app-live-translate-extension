/**
 * Compression Agent Tools — data tools the agent can call via Harness.
 * These are NOT LLM function-calling tools in the API sense; they are
 * harness-provided data fetchers that the agent's prompt references.
 * If we later enable true function-calling, these map to tool definitions.
 * @module harness/agent/tools
 */

/**
 * Build tool definitions for compression agent (for providers that support function-calling).
 * Returned as OpenAI tools / Gemini functionDeclarations compatible shape.
 */
export function getCompressionToolDefs() {
  return [
    {
      name: 'get_compressed_history',
      description: 'Get existing compressed summary (older history already summarized)',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_pending_segment',
      description: 'Get pending transcript segment not yet compressed (new utterances)',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_recent_questions',
      description: 'Get recent questions detected in the conversation (to prioritize QA-relevant info)',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  ];
}

/**
 * Execute a tool by name using store/harness data.
 * @param {string} name
 * @param {object} args
 * @param {{ store: any }} ctx
 * @returns {Promise<any>}
 */
export async function executeCompressionTool(name, args, ctx) {
  const s = ctx.store.getState();
  switch (name) {
    case 'get_compressed_history':
      return { compressedSummary: s.compressedSummary || '', lastCompressedIdx: s.lastCompressedIdx };
    case 'get_pending_segment': {
      const segment = s.finalizedEnPhrases.slice(s.lastCompressedIdx).join('\n');
      return { segment: segment.slice(-8000), pendingCount: s.finalizedEnPhrases.length - s.lastCompressedIdx };
    }
    case 'get_recent_questions': {
      const entries = Object.entries(s.questionSuggestions || {});
      const recent = entries.slice(-5).map(([idx, v]) => ({ idx: Number(idx), question: v.question }));
      return { questions: recent };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Gather all tool data eagerly (for single-shot agent without loop).
 * This is the harness pre-fetching step — agent prompt receives tool outputs upfront.
 * @param {{ store: any }} ctx
 * @returns {Promise<object>}
 */
export async function gatherCompressionContext(ctx) {
  const [history, segment, questions] = await Promise.all([
    executeCompressionTool('get_compressed_history', {}, ctx),
    executeCompressionTool('get_pending_segment', {}, ctx),
    executeCompressionTool('get_recent_questions', {}, ctx),
  ]);
  return { history, segment, questions };
}
