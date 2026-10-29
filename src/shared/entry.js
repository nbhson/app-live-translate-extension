/**
 * Shared runtime bundle — single source of truth for code that must run in
 * BOTH the classic-script sidepanel runtime and ESM modules.
 *
 * Vite builds this to `dist/shared.js`; sidepanel.html loads it before
 * sidepanel.js. The bundle exposes `globalThis.LiveTranslateShared` so the
 * non-module sidepanel.js can consume the canonical, tested implementations
 * instead of hand-maintained mirrors (drift R2-1/R2-2).
 *
 * MV3 CSP: same-origin script, no eval — safe for extension_pages.
 * @module shared/entry
 */
import * as llm from '../services/llm/provider.js';
import * as translateProviders from '../services/translate/providers.js';
import { translateText as translateTextCore, abortAll as abortTranslations } from '../services/translate/translate.js';
import { isCapturableTab } from '../background/isCapturableTab.js';
import { isLocalHostUrl, isGeminiHostUrl } from '../utils/isLocalHostUrl.js';
import { escapeHtml } from '../utils/escapeHtml.js';

const shared = {
  llm: {
    fetchWithRetry: llm.fetchWithRetry,
    fetchWithTimeout: llm.fetchWithTimeout,
    callProviderForSuggest: llm.callProviderForSuggest,
    callProviderGeneric: llm.callProviderGeneric,
    isThinkingEnabled: llm.isThinkingEnabled,
    geminiThinkingOffConfig: llm.geminiThinkingOffConfig,
    openaiThinkingOffParams: llm.openaiThinkingOffParams,
    friendlyProviderError: llm.friendlyProviderError,
    isGemini: llm.isGemini,
  },
  translate: {
    translateText: translateTextCore,
    translateViaMyMemory: translateProviders.translateViaMyMemory,
    translateViaLingva: translateProviders.translateViaLingva,
    translateViaAI: translateProviders.translateViaAI,
    translateWithFallbackChain: translateProviders.translateWithFallbackChain,
    isValidAiProviderConfig: translateProviders.isValidAiProviderConfig,
    buildAiTranslatePrompt: translateProviders.buildAiTranslatePrompt,
    MYMEMORY_ENDPOINT: translateProviders.MYMEMORY_ENDPOINT,
    LINGVA_ENDPOINTS: translateProviders.LINGVA_ENDPOINTS,
  },
  isCapturableTab,
  isLocalHostUrl,
  isGeminiHostUrl,
  escapeHtml,
};

if (typeof globalThis !== 'undefined') {
  globalThis.LiveTranslateShared = Object.freeze(shared);
}

export { llm, translateProviders, isCapturableTab, isLocalHostUrl, isGeminiHostUrl, escapeHtml };
