/**
 * Main entry — ESM, modular, imports from src/* (Vite builds to dist)
 * This file is the future sidepanel entry (type="module"). Current sidepanel.js remains for compat.
 * @module main
 */
import { CONFIG } from './config.js';
import { store } from './state/store.js';
import { DOM } from './ui/dom.js';
import { showToast } from './ui/components/toast.js';
import { showStatus } from './ui/components/status.js';
import { autoScroll, isNearTop, setShouldStick } from './ui/transcript/scroll.js';
import { escapeHtml } from './utils/escapeHtml.js';
import { isQuestion } from './utils/isQuestion.js';
import { splitIntoUtterances } from './utils/splitIntoUtterances.js';
import { buildSuggestPrompt } from './utils/buildSuggestPrompt.js';
import { parseSuggestAnswers, synthesizeStructures } from './utils/parseSuggestAnswers.js';
import { storageGet, storageSet } from './services/storage.js';
import { isCapturableTab } from './background/isCapturableTab.js';
import DOMPurify from 'dompurify';

// Example: wire up minimal init to prove modular import works
console.log('[main] CONFIG', CONFIG.SILENCE_THRESHOLD, 'isQuestion', isQuestion('Are you ok?'), 'purify', typeof DOMPurify.sanitize);

// Export for tests / future sidepanel ESM
export { CONFIG, store, DOM, showToast, showStatus, autoScroll, isNearTop, escapeHtml, isQuestion, splitIntoUtterances, buildSuggestPrompt, parseSuggestAnswers, isCapturableTab };
