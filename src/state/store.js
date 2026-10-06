/**
 * Centralized store — single source of truth, subscribe, no globals scattered
 * @module state/store
 */
import { CONFIG } from '../config.js';
import { compactTranscriptState } from '../services/transcript/compact.js';
import { appendFullHistory } from '../services/summary/summarySource.js';

export function createStore(initial = {}) {
  const state = {
    recognition: null,
    isListening: false,
    lastFinalIndex: -1,
    activeAudioTrack: null,
    finalizedOffset: 0,
    silenceTimer: null,
    finalizedEnPhrases: [],
    finalizedViPhrases: [],
    utteranceSpeakers: [],
    // Append-only archive of EVERY finalized EN utterance (never compacted).
    // AI summary reads this so hour-long meetings keep head content after
    // the live window is compacted. Capped inside appendFullHistory (~5000).
    fullEnHistory: [],
    questionSuggestions: {},
    suggestEnabled: true,
    utteranceDomCache: [],
    pendingRenderQueue: new Set(),
    renderScheduled: false,
    selectedQuestionIdx: null,
    suggestView: 'both',
    compressEnabled: false,
    compressedSummary: '',
    lastCompressedIdx: 0,
    compressTimer: null,
    compressInProgress: false,
    translationCache: new Map(),
    activeTranslateControllers: new Set(),
    suggestQueue: Promise.resolve(),
    wordCountRaf: null,
    currentSpeakerId: 0,
    lastSpeakerFeatures: null,
    speakerVadState: 'silence',
    speakerVadSilenceMs: 0,
    speakerVadLastSwitchAt: 0,
    speakerMonitor: null,
    suggestContextPrompt: '',
    contextPromptSaveTimer: null,
    providerConfig: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: '', model: 'gemini-2.5-flash', thinkingEnabled: true },
    ...initial,
  };

  const listeners = new Set();
  return {
    getState: () => state,
    /** @param {Partial<typeof state>} patch */
    setState(patch) {
      Object.assign(state, patch);
      for (const fn of listeners) try { fn(state); } catch {}
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** reset transcript */
    resetTranscript() {
      state.finalizedEnPhrases = [];
      state.finalizedViPhrases = [];
      state.utteranceSpeakers = [];
      state.fullEnHistory = [];
      state.questionSuggestions = {};
      state.utteranceDomCache = [];
      state.currentSpeakerId = 0;
      state.lastSpeakerFeatures = null;
      state.speakerVadLastSwitchAt = 0;
      state.lastFinalIndex = -1;
      state.finalizedOffset = 0;
      if (state.silenceTimer) { clearTimeout(state.silenceTimer); state.silenceTimer = null; }
    },
    /**
     * Append finalized utterances to the append-only summary archive.
     * Call for every new finalized utterance (in addition to the live window).
     * @param {string|string[]} texts
     */
    appendFullHistory(texts) {
      const arr = Array.isArray(texts) ? texts : [texts];
      state.fullEnHistory = appendFullHistory(state.fullEnHistory, arr);
      this.setState({});
    },
    /**
     * Memory guard — drop oldest utterances past the cap and re-index.
     * Dropped head is archived into fullEnHistory so summary keeps full coverage.
     * Caller owns DOM removal for dropped cache roots.
     * @param {number} [keepMax]
     * @returns {boolean} true if compaction happened
     */
    compactTranscript(keepMax = CONFIG.MAX_DOM_UTTERANCES) {
      const next = compactTranscriptState({
        en: state.finalizedEnPhrases,
        vi: state.finalizedViPhrases,
        speakers: state.utteranceSpeakers,
        cache: state.utteranceDomCache,
        suggestions: state.questionSuggestions,
        selectedIdx: state.selectedQuestionIdx,
        lastCompressedIdx: state.lastCompressedIdx,
      }, keepMax);
      if (!next.shift) return false;
      state.finalizedEnPhrases = next.en;
      state.finalizedViPhrases = next.vi;
      state.utteranceSpeakers = next.speakers;
      state.utteranceDomCache = next.cache;
      state.questionSuggestions = next.suggestions;
      state.selectedQuestionIdx = next.selectedIdx;
      state.lastCompressedIdx = next.lastCompressedIdx;
      // Archive dropped head — but only backfill what the append path missed
      // (normal flow already appended these via appendFullHistory).
      if (Array.isArray(next.dropped) && next.dropped.length > 0) {
        const known = new Set(state.fullEnHistory);
        const missing = next.dropped.filter(
          (u) => typeof u === 'string' && u.trim() && !known.has(u),
        );
        if (missing.length > 0) state.fullEnHistory = appendFullHistory(state.fullEnHistory, missing);
      }
      this.setState({});
      return true;
    },
  };
}

export const store = createStore();
