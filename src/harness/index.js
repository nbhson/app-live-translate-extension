/**
 * Harness — composition root for Chrome Extension.
 * Core never imports chrome/window/fetch directly; it imports from this harness.
 * For production: createHarness() with real globals. For tests: inject mocks.
 * @module harness
 */
import { store } from '../state/store.js';
import { CONFIG } from '../config.js';
import { createStorageHarness } from './storage.harness.js';
import { createChromeHarness } from './chrome.harness.js';
import { createSpeechHarness } from './speech.harness.js';
import { createAudioHarness } from './audio.harness.js';
import { createLlmHarness } from './llm.harness.js';
import { createTranslateHarness } from './translate.harness.js';
import { createCompressionAgent, getCompressionToolDefs, gatherCompressionContext } from './agent/index.js';

export function createHarness({ chromeApi, navigatorApi, windowApi, fetchApi, storeOverride } = {}) {
  const _store = storeOverride ?? store;
  const storage = createStorageHarness();
  const chromeHarness = createChromeHarness({ chromeApi, navigatorApi });
  const speech = createSpeechHarness({ store: _store, windowApi });
  const audio = createAudioHarness({ store: _store, windowApi });
  const llm = createLlmHarness({ fetchApi });
  const translate = createTranslateHarness();
  const compressionAgent = createCompressionAgent({ store: _store, llmHarness: createLlmHarness({ fetchApi }) });

  return {
    CONFIG,
    store: _store,
    storage,
    chrome: chromeHarness,
    speech,
    audio,
    llm,
    translate,
    agent: {
      compression: compressionAgent,
      getCompressionToolDefs,
      gatherCompressionContext,
    },
    /**
     * Wire speech recognition with given actions (UI callbacks).
     * Called from main.js after store + UI are ready.
     */
    wireSpeech(actions) {
      const harness = createSpeechHarness({ store: _store, windowApi, actions });
      return harness;
    },
  };
}

export const harness = createHarness();

// Re-exports for ergonomic imports
export { CONFIG } from '../config.js';
export { store } from '../state/store.js';
export { createStorageHarness } from './storage.harness.js';
export { createChromeHarness } from './chrome.harness.js';
export { createSpeechHarness } from './speech.harness.js';
export { createAudioHarness } from './audio.harness.js';
export { createLlmHarness } from './llm.harness.js';
export { createTranslateHarness } from './translate.harness.js';
