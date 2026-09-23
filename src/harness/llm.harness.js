/**
 * LLM Harness — wraps provider calls behind injectable adapter.
 * Delegates to src/services/llm/provider so retry/timeout logic stays single-source.
 * @module harness/llm.harness
 */
import { fetchWithTimeout, fetchWithRetry, callProviderForSuggest, callProviderGeneric, isGemini } from '../services/llm/provider.js';

export function createLlmHarness({ fetchApi } = {}) {
  // fetchApi injection for tests: temporarily override global fetch for provider calls
  const withFetch = async (fn) => {
    if (!fetchApi) return fn();
    const orig = globalThis.fetch;
    globalThis.fetch = fetchApi;
    try { return await fn(); } finally { globalThis.fetch = orig; }
  };
  return {
    isGemini,
    fetchWithTimeout: (url, opts, timeout) => withFetch(() => fetchWithTimeout(url, opts, timeout)),
    fetchWithRetry: (url, opts, timeout, retries) => withFetch(() => fetchWithRetry(url, opts, timeout, retries)),
    callForSuggest: (prompt, cfg, opts) => withFetch(() => callProviderForSuggest(prompt, cfg, opts)),
    callGeneric: (prompt, cfg, opts) => withFetch(() => callProviderGeneric(prompt, cfg, opts)),
    // aliases matching provider.js names
    callProviderForSuggest: (prompt, cfg, opts) => withFetch(() => callProviderForSuggest(prompt, cfg, opts)),
    callProviderGeneric: (prompt, cfg, opts) => withFetch(() => callProviderGeneric(prompt, cfg, opts)),
  };
}

export const llmHarness = createLlmHarness();
