/**
 * Translate Harness — wraps translateText + batch + cache behind injectable adapter.
 * Delegates to src/services/translate/* so existing tests keep passing.
 * @module harness/translate.harness
 */
import { createTranslateCache } from '../services/translate/cache.js';
import { translateBatchConcurrent } from '../services/translate/batch.js';
import { translateText as coreTranslate, abortAll } from '../services/translate/translate.js';
import { CONFIG } from '../config.js';

export function createTranslateHarness({ cache, controllers } = {}) {
  const _cache = cache ?? createTranslateCache(CONFIG.TRANSLATION_CACHE_MAX);
  const _controllers = controllers ?? new Set();

  return {
    cache: _cache,
    controllers: _controllers,

    translateText(text, opts = {}) {
      return coreTranslate(text, { cache: _cache, controllers: _controllers, ...opts });
    },

    translateBatch(tasks, concurrency = CONFIG.MAX_CONCURRENT_TRANSLATE) {
      return translateBatchConcurrent(tasks, concurrency);
    },

    createCache(limit = CONFIG.TRANSLATION_CACHE_MAX) {
      return createTranslateCache(limit);
    },

    abortAll() { abortAll(_controllers); },

    coreTranslate,
    coreBatch: translateBatchConcurrent,
  };
}

export const translateHarness = createTranslateHarness();
