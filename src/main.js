/**
 * Main entry — ESM, modular, imports via Harness (Vite builds to dist/main.js)
 * Harness is the single composition root: all external I/O goes through it.
 * Sidepanel.html keeps loading sidepanel.js (non-module) for backwards compat;
 * dist/main.js is available for future ESM sidepanel. Both share same core.
 * @module main
 */
import { CONFIG } from './config.js';
import { store } from './state/store.js';
import { DOM } from './ui/dom.js';
import { showToast } from './ui/components/toast.js';
import { showStatus } from './ui/components/status.js';
import { autoScroll, isNearTop } from './ui/transcript/scroll.js';
import { escapeHtml } from './utils/escapeHtml.js';
import { isQuestion } from './utils/isQuestion.js';
import { splitIntoUtterances } from './utils/splitIntoUtterances.js';
import { buildSuggestPrompt } from './utils/buildSuggestPrompt.js';
import { parseSuggestAnswers, synthesizeStructures } from './utils/parseSuggestAnswers.js';
import { storageGet, storageSet } from './services/storage.js';
import { isCapturableTab } from './background/isCapturableTab.js';
import { createHarness } from './harness/index.js';
import { getContextSnapshot } from './ui/components/contextInspector.js';
import { buildCompressPrompt } from './utils/buildCompressPrompt.js';
import { shouldTriggerAiDetect, shouldTriggerAiSplit, shouldTriggerAiFalseNegative } from './utils/shouldTriggerAiDetect.js';
import { buildDetectPrompt, parseDetectResponse, validateAiQuestions, detectQuestionsViaAI } from './services/llm/questionDetect.js';
import DOMPurify from 'dompurify';

// Composition root — inject real globals; tests inject mocks via createHarness({chromeApi: mock})
export const harness = createHarness();

// Prove wiring
console.log('[main] harness ready', {
  config: CONFIG.SILENCE_THRESHOLD,
  isQuestion: isQuestion('Are you ok?'),
  purify: typeof DOMPurify.sanitize,
  harness: Object.keys(harness),
});

// Future ESM sidepanel init would be:
// harness.speech.attachHandlers(harness.speech.createRecognition(), harness.store, { ...uiActions })

// Export for tests / future sidepanel ESM — keep legacy exports + harness
export { CONFIG, store, DOM, showToast, showStatus, autoScroll, isNearTop, escapeHtml, isQuestion, splitIntoUtterances, buildSuggestPrompt, parseSuggestAnswers, isCapturableTab, storageGet, storageSet, getContextSnapshot, buildCompressPrompt, shouldTriggerAiDetect, shouldTriggerAiSplit, shouldTriggerAiFalseNegative, buildDetectPrompt, parseDetectResponse, validateAiQuestions, detectQuestionsViaAI };
