import { describe, it, expect } from 'vitest';
import {
  llm,
  translateProviders,
  isCapturableTab,
  isLocalHostUrl,
  isGeminiHostUrl,
  escapeHtml,
  computeSpectralCentroid,
  sanitizePromptSegment,
  sanitizePromptContext,
} from '../src/shared/entry.js';

describe('shared runtime bundle (sidepanel + SW single source of truth)', () => {
  it('registers frozen globalThis.LiveTranslateShared on import', () => {
    const s = globalThis.LiveTranslateShared;
    expect(s).toBeTruthy();
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.keys(s).sort()).toEqual([
      'computeSpectralCentroid', 'escapeHtml', 'history', 'isCapturableTab', 'isGeminiHostUrl',
      'isLocalHostUrl', 'llm', 'sanitizePromptContext', 'sanitizePromptSegment', 'sessions', 'siteMatch', 'translate',
    ]);
  });

  it('exposes the same function identities as the canonical modules', () => {
    const mod = globalThis.LiveTranslateShared;
    expect(mod.llm.fetchWithRetry).toBe(llm.fetchWithRetry);
    expect(mod.llm.callProviderForSuggest).toBe(llm.callProviderForSuggest);
    expect(mod.translate.translateWithFallbackChain).toBe(translateProviders.translateWithFallbackChain);
    expect(mod.isCapturableTab({ id: 1, url: 'https://a.com' })).toBe(true);
    expect(mod.isCapturableTab({ id: 1, url: 'chrome://settings' })).toBe(false);
    expect(isLocalHostUrl('https://evil.com/?x=localhost')).toBe(false);
    expect(isLocalHostUrl('http://localhost:11434/v1')).toBe(true);
    expect(isGeminiHostUrl('https://generativelanguage.googleapis.com/v1beta')).toBe(true);
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
    expect(sanitizePromptSegment('a'.repeat(20000))).toHaveLength(12000);
    expect(sanitizePromptContext('x'.repeat(700))).toHaveLength(600);
  });
});
