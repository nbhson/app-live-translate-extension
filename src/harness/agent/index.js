/**
 * Agent Harness — exports compression agent + tool infra.
 * Currently only compression is agentic; suggestion/summary remain single-shot prompts
 * (as requested: summary unchanged, suggestion unchanged, compression = agent).
 * Loop is NOT needed for compression — see compression.agent.js for rationale.
 * @module harness/agent
 */
export { getCompressionToolDefs, executeCompressionTool, gatherCompressionContext } from './tools.js';
export { createCompressionAgent } from './compression.agent.js';
