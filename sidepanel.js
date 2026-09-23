// Chrome Extension: Live Translate Side Panel Script
// Refactored 2026-09-18 — Best Practice (>=8/10): CONFIG/State/DOM isolation, pure utils, promise storage, abortable fetch, DocumentFragment, validated inputs.
// Summary functions (generateSummary/parseMarkdown) intentionally untouched per spec.

'use strict';
try { performance.mark('sidepanel-js-start'); } catch {}

/** @type {const} */
const CONFIG = Object.freeze({
  SILENCE_THRESHOLD: 900,
  MAX_INTERIM_LENGTH: 80,
  MAX_DOM_UTTERANCES: 120,
  INTERIM_DEBOUNCE_MS: 420,
  TRANSLATION_CACHE_MAX: 500,
  MAX_CONCURRENT_TRANSLATE: 3,
  COMPRESS_INTERVAL_MS: 5 * 60 * 1000,
  COMPRESS_RECENT_KEEP: 10,
  COMPRESS_MAX_CHARS: 3000,
  SPEAKER_VAD_RMS_THRESH: 0.012,
  SPEAKER_MIN_PAUSE_MS: 350,
  SPEAKER_MIN_SPEECH_MS: 600,
  SPEAKER_CENTROID_DIFF: 320,
  TRANSLATE_TIMEOUT_MS: 8500,
  STORAGE_KEYS: Object.freeze({
    suggestEnabled: 'suggestEnabled',
    compressEnabled: 'compressEnabled',
    compressedSummary: 'compressedSummary',
    lastCompressedIdx: 'lastCompressedIdx',
    suggestContextPrompt: 'suggestContextPrompt',
    providerBaseUrl: 'providerBaseUrl',
    providerApiKey: 'providerApiKey',
    providerModel: 'providerModel',
  }),
});
const SILENCE_THRESHOLD = CONFIG.SILENCE_THRESHOLD;
const MAX_INTERIM_LENGTH = CONFIG.MAX_INTERIM_LENGTH;
const MAX_DOM_UTTERANCES = CONFIG.MAX_DOM_UTTERANCES;
const INTERIM_DEBOUNCE_MS = CONFIG.INTERIM_DEBOUNCE_MS;
const TRANSLATION_CACHE_MAX = CONFIG.TRANSLATION_CACHE_MAX;
const MAX_CONCURRENT_TRANSLATE = CONFIG.MAX_CONCURRENT_TRANSLATE;
const COMPRESS_INTERVAL_MS = CONFIG.COMPRESS_INTERVAL_MS;
const COMPRESS_RECENT_KEEP = CONFIG.COMPRESS_RECENT_KEEP;
const COMPRESS_MAX_CHARS = CONFIG.COMPRESS_MAX_CHARS;
const SPEAKER_VAD_RMS_THRESH = CONFIG.SPEAKER_VAD_RMS_THRESH;
const SPEAKER_MIN_PAUSE_MS = CONFIG.SPEAKER_MIN_PAUSE_MS;
const SPEAKER_MIN_SPEECH_MS = CONFIG.SPEAKER_MIN_SPEECH_MS;
const SPEAKER_CENTROID_DIFF = CONFIG.SPEAKER_CENTROID_DIFF;

/** Centralized mutable state — single source, no globals scattered */
const State = {
  recognition: null,
  isListening: false,
  lastFinalIndex: -1,
  activeAudioTrack: null,
  finalizedOffset: 0,
  silenceTimer: null,
  finalizedEnPhrases: /** @type {string[]} */([]),
  finalizedViPhrases: /** @type {string[]} */([]),
  utteranceSpeakers: /** @type {number[]} */([]),
  questionSuggestions: /** @type {Record<number, {state:string,question:string,answers:string[],structures:string[],error?:string}>} */({}),
  suggestEnabled: true,
  utteranceDomCache: /** @type {Array<null|{root:HTMLElement,body:HTMLElement,colEn:HTMLElement,colVi:HTMLElement,enText:HTMLElement,viText:HTMLElement,copyEn:HTMLButtonElement,copyVi:HTMLButtonElement,suggestCard:HTMLElement,isLive:boolean,_speakerId:number}>} */([]),
  pendingRenderQueue: new Set(),
  renderScheduled: false,
  selectedQuestionIdx: null,
  suggestView: /** @type {'both'|'structure'|'complete'} */('both'),
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
};
// Legacy aliases for minimal diff in untouched summary code — keep backward compat
let recognition = State.recognition;
let isListening = State.isListening;
let lastFinalIndex = State.lastFinalIndex;
let activeAudioTrack = State.activeAudioTrack;
let finalizedOffset = State.finalizedOffset;
let silenceTimer = State.silenceTimer;
let finalizedEnPhrases = State.finalizedEnPhrases;
let finalizedViPhrases = State.finalizedViPhrases;
let utteranceSpeakers = State.utteranceSpeakers;
let questionSuggestions = State.questionSuggestions;
let suggestEnabled = State.suggestEnabled;
let utteranceDomCache = State.utteranceDomCache;
let pendingRenderQueue = State.pendingRenderQueue;
let renderScheduled = State.renderScheduled;
let selectedQuestionIdx = State.selectedQuestionIdx;
let suggestView = State.suggestView;
let compressEnabled = State.compressEnabled;
let compressedSummary = State.compressedSummary;
let lastCompressedIdx = State.lastCompressedIdx;
let compressTimer = State.compressTimer;
let compressInProgress = State.compressInProgress;
const translationCache = State.translationCache;
let activeTranslateControllers = State.activeTranslateControllers;
let suggestQueue = State.suggestQueue;
let wordCountRaf = State.wordCountRaf;
let currentSpeakerId = State.currentSpeakerId;
let lastSpeakerFeatures = State.lastSpeakerFeatures;
let speakerVadState = State.speakerVadState;
let speakerVadSilenceMs = State.speakerVadSilenceMs;
let speakerVadLastSwitchAt = State.speakerVadLastSwitchAt;
let speakerMonitor = State.speakerMonitor;
let suggestContextPrompt = State.suggestContextPrompt;
let contextPromptSaveTimer = State.contextPromptSaveTimer;
let isSuggestRunning = false;
let wordCountDirty = false;
/** Live sub-view: 'transcript' | 'answers' | 'context' | 'split' — view-only, no transcript logic depends on it */
let liveView = 'transcript';
/**
 * Switch live sub-view — guarded, no throw. Sections keep their IDs so all
 * existing logic (dock render, inspector, compress) works in any view.
 * 'split' shows transcript + answers stacked together.
 * @param {string} name
 */
function setLiveView(name) {
  if (name !== 'transcript' && name !== 'answers' && name !== 'context' && name !== 'split') return;
  liveView = name;
  try {
    const map = {
      transcript: document.getElementById('transcriptSection'),
      answers: document.getElementById('suggestionDock'),
      context: document.getElementById('contextView'),
    };
    const visible = (k) => name === 'split' ? (k === 'transcript' || k === 'answers') : k === name;
    for (const k of Object.keys(map)) {
      const el = map[k];
      if (!el) continue;
      const on = visible(k);
      el.classList.toggle('active', on);
      el.setAttribute('aria-hidden', String(!on));
    }
    const liveTab = document.getElementById('liveTabContent');
    if (liveTab) liveTab.classList.toggle('show-split', name === 'split');
    document.querySelectorAll('.live-switch-btn').forEach((b) => {
      const on = b.dataset.liveview === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    if (name === 'answers' || name === 'split') {
      const badge = document.getElementById('answersCountBadge');
      if (badge) badge.classList.remove('ping');
      // Full-area view: drop legacy dock inline heights (old resizer/localStorage)
      // so flex:1 fills parent instead of staying at a tiny saved px value.
      try {
        const dock = map.answers;
        if (dock) { dock.style.maxHeight = ''; dock.style.minHeight = ''; dock.style.height = ''; }
      } catch {}
      if (suggestionBody) suggestionBody.scrollTop = 0;
    }
  } catch (e) { console.warn('[setLiveView]', e); }
}
/** Wire live sub-view switcher — guarded */
function setupLiveView() {
  try {
    document.querySelectorAll('.live-switch-btn').forEach((b) => {
      b.addEventListener('click', () => setLiveView(b.dataset.liveview));
    });
  } catch (e) { console.warn('[setupLiveView]', e); }
}
/** Sync legacy aliases back to State after mutations (called at end of mutating fns) */
function syncState() {
  State.recognition = recognition; State.isListening = isListening; State.lastFinalIndex = lastFinalIndex;
  State.activeAudioTrack = activeAudioTrack; State.finalizedOffset = finalizedOffset; State.silenceTimer = silenceTimer;
  State.finalizedEnPhrases = finalizedEnPhrases; State.finalizedViPhrases = finalizedViPhrases;
  State.utteranceSpeakers = utteranceSpeakers; State.questionSuggestions = questionSuggestions;
  State.suggestEnabled = suggestEnabled; State.utteranceDomCache = utteranceDomCache;
  State.pendingRenderQueue = pendingRenderQueue; State.renderScheduled = renderScheduled;
  State.selectedQuestionIdx = selectedQuestionIdx; State.suggestView = suggestView;
  State.compressEnabled = compressEnabled; State.compressedSummary = compressedSummary;
  State.lastCompressedIdx = lastCompressedIdx; State.compressTimer = compressTimer;
  State.compressInProgress = compressInProgress; State.wordCountRaf = wordCountRaf;
  State.currentSpeakerId = currentSpeakerId; State.lastSpeakerFeatures = lastSpeakerFeatures;
  State.speakerVadState = speakerVadState; State.speakerVadSilenceMs = speakerVadSilenceMs;
  State.speakerVadLastSwitchAt = speakerVadLastSwitchAt; State.speakerMonitor = speakerMonitor;
  State.suggestContextPrompt = suggestContextPrompt; State.contextPromptSaveTimer = contextPromptSaveTimer;
}

// --- Harness (Chrome Extension) — single composition root for sidepanel runtime ---
// Mirrors src/harness/* (ESM). This object isolates chrome/window/fetch so core
// logic is testable & future ESM sidepanel (dist/main.js) can share same contract.
// Existing functions delegate to Harness; UI behavior unchanged.
const Harness = (() => {
  const _isCapturableTab = (tab) => {
    if (!tab || typeof tab.id !== 'number' || typeof tab.url !== 'string') return false;
    const s = String(tab.url).trim();
    if (!s || s.startsWith('chrome://') || s.startsWith('chrome-extension://') || s.startsWith('about:') || s.startsWith('edge://')) return false;
    try { const u = new URL(s); if (!['http:', 'https:'].includes(u.protocol)) return false; if (['chrome.google.com','chromewebstore.google.com','accounts.google.com'].some(b => u.hostname===b || u.hostname.endsWith('.'+b))) return false; return true; } catch { return false; }
  };
  return Object.freeze({
    config: CONFIG,
    state: State,
    isCapturableTab: _isCapturableTab,
    storage: { get: (...a) => storageGet(...a), set: (...a) => storageSet(...a) },
    chrome: {
      sendMessage: (msg) => sendMessageAsync(msg),
      isCapturableTab: _isCapturableTab,
      checkMicPermission: () => checkMicPermission(),
      openPermissionTab: () => openPermissionTab(),
    },
    llm: {
      fetchWithRetry: (...a) => fetchWithRetrySidepanel(...a),
      callForSuggest: (p) => callProviderForSuggest(p),
      callGeneric: (p, o) => callProviderGeneric(p, o),
    },
    translate: {
      translateText: (t, o) => translateText(t, o),
      translateBatch: (tasks, c) => translateBatchConcurrent(tasks, c),
    },
    audio: {
      computeSpectralCentroid: (d, r) => computeSpectralCentroid(d, r),
      shouldToggleSpeaker: (f, p) => shouldToggleSpeaker(f, p),
      setupMonitor: (s) => setupSpeakerMonitor(s),
      teardown: () => teardownSpeakerMonitor(),
    },
    speech: {
      parseEvent: (e) => parseRecognitionEvent(e),
    },
  });
})();
if (typeof window !== 'undefined') { try { window.Harness = Harness; } catch {} }

// Provider config state (custom: baseUrl + apiKey + model)
let providerConfig = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: '',
  model: 'gemini-2.5-flash'
};
// keep alias for backward compat in storage
let geminiConfig = providerConfig;

// --- DOM cache with validation ---
/** @param {string} id */
function $id(id) { const el = document.getElementById(id); if (!el) console.warn(`[DOM] missing #${id}`); return el; }
const DOM = Object.freeze({
  toggleBtn: $id('toggleBtn'), playIcon: $id('playIcon'), stopIcon: $id('stopIcon'), btnText: $id('btnText'), clearBtn: $id('clearBtn'), statusText: $id('statusText'),
  logoDot: document.querySelector('.logo-dot'), audioSourceSelect: $id('audioSourceSelect'),
  englishLog: $id('englishLog'), englishInterim: $id('englishInterim'), enPlaceholder: $id('enPlaceholder'),
  vietnameseLog: $id('vietnameseLog'), vietnameseInterim: $id('vietnameseInterim'), viPlaceholder: $id('viPlaceholder'),
  transcriptFeed: $id('transcriptFeed'), combinedPlaceholder: $id('combinedPlaceholder'), transcriptContent: $id('transcriptContent'), combinedWordCount: $id('combinedWordCount'), interimBlock: $id('interimBlock'), copyAllBtn: $id('copyAllBtn'),
  suggestToggle: $id('suggestToggle'), suggestionDock: $id('suggestionDock'), qCountBadge: $id('qCountBadge'), questionPills: $id('questionPills'), suggestionBody: $id('suggestionBody'), suggestEmpty: $id('suggestEmpty'), clearSuggestionsBtn: $id('clearSuggestionsBtn'),
  copyEnBtn: $id('copyEnBtn'), copyViBtn: $id('copyViBtn'), permissionOverlay: $id('permissionOverlay'), grantPermissionBtn: $id('grantPermissionBtn'), liveBadge: $id('liveBadge'), enWordCount: $id('enWordCount'), viWordCount: $id('viWordCount'), toastContainer: $id('toastContainer'),
  tabLive: $id('tabLive'), tabSummary: $id('tabSummary'), liveTabContent: $id('liveTabContent'), summaryTabContent: $id('summaryTabContent'),
  settingsBtn: $id('settingsBtn'), settingsOverlay: $id('settingsOverlay'), closeSettingsBtn: $id('closeSettingsBtn'), baseUrlInput: $id('baseUrlInput'), apiKeyInput: $id('apiKeyInput'), toggleApiKeyVisibilityBtn: $id('toggleApiKeyVisibilityBtn'), modelInput: $id('modelInput'), geminiModelSelect: $id('geminiModelSelect'), saveSettingsBtn: $id('saveSettingsBtn'),
  apiWarningCard: $id('apiWarningCard'), configNowBtn: $id('configNowBtn'), summaryLangSelect: $id('summaryLang'), summaryDetailSelect: $id('summaryDetail'), generateSummaryBtn: $id('generateSummaryBtn'), copySummaryBtn: $id('copySummaryBtn'), summaryPlaceholder: $id('summaryPlaceholder'), summaryMarkdown: $id('summaryMarkdown'), summaryLoading: $id('summaryLoading'), summaryContent: $id('summaryContent'),
  contextPromptInput: $id('contextPromptInput'), contextPromptBadge: $id('contextPromptBadge'), clearContextPromptBtn: $id('clearContextPromptBtn'), contextPromptWrap: $id('contextPromptWrap'), contextPromptToggle: $id('contextPromptToggle'), contextPromptCollapsible: $id('contextPromptCollapsible'),
  inspectorToggle: $id('inspectorToggle'), inspectorMeta: $id('inspectorMeta'), inspectorBody: $id('inspectorBody'), inspectorChevron: $id('inspectorChevron'), paneLive: $id('paneLive'), paneCompressed: $id('paneCompressed'), panePending: $id('panePending'), copyContextBtn: $id('copyContextBtn'),
  dockResizer: $id('dockResizer'), dockExpandBtn: $id('dockExpandBtn'),
});
// Legacy aliases for untouched summary code
const toggleBtn = DOM.toggleBtn; const playIcon = DOM.playIcon; const stopIcon = DOM.stopIcon; const btnText = DOM.btnText; const clearBtn = DOM.clearBtn; const statusText = DOM.statusText; const logoDot = DOM.logoDot; const audioSourceSelect = DOM.audioSourceSelect;
const englishLog = DOM.englishLog; const englishInterim = DOM.englishInterim; const enPlaceholder = DOM.enPlaceholder; const vietnameseLog = DOM.vietnameseLog; const vietnameseInterim = DOM.vietnameseInterim; const viPlaceholder = DOM.viPlaceholder;
const transcriptFeed = DOM.transcriptFeed; const combinedPlaceholder = DOM.combinedPlaceholder; const transcriptContent = DOM.transcriptContent; const combinedWordCount = DOM.combinedWordCount; const interimBlock = DOM.interimBlock; const copyAllBtn = DOM.copyAllBtn; const suggestToggle = DOM.suggestToggle; const suggestionDock = DOM.suggestionDock; const qCountBadge = DOM.qCountBadge; const questionPills = DOM.questionPills; const suggestionBody = DOM.suggestionBody; const suggestEmpty = DOM.suggestEmpty; const clearSuggestionsBtn = DOM.clearSuggestionsBtn;
const copyEnBtn = DOM.copyEnBtn; const copyViBtn = DOM.copyViBtn; const permissionOverlay = DOM.permissionOverlay; const grantPermissionBtn = DOM.grantPermissionBtn; const liveBadge = DOM.liveBadge; const enWordCount = DOM.enWordCount; const viWordCount = DOM.viWordCount; const toastContainer = DOM.toastContainer;
const tabLive = DOM.tabLive; const tabSummary = DOM.tabSummary; const liveTabContent = DOM.liveTabContent; const summaryTabContent = DOM.summaryTabContent;
const settingsBtn = DOM.settingsBtn; const settingsOverlay = DOM.settingsOverlay; const closeSettingsBtn = DOM.closeSettingsBtn; const baseUrlInput = DOM.baseUrlInput; const apiKeyInput = DOM.apiKeyInput; const toggleApiKeyVisibilityBtn = DOM.toggleApiKeyVisibilityBtn; const modelInput = DOM.modelInput; const geminiModelSelect = DOM.geminiModelSelect; const saveSettingsBtn = DOM.saveSettingsBtn;
const apiWarningCard = DOM.apiWarningCard; const configNowBtn = DOM.configNowBtn; const summaryLangSelect = DOM.summaryLangSelect; const summaryDetailSelect = DOM.summaryDetailSelect; const generateSummaryBtn = DOM.generateSummaryBtn; const copySummaryBtn = DOM.copySummaryBtn; const summaryPlaceholder = DOM.summaryPlaceholder; const summaryMarkdown = DOM.summaryMarkdown; const summaryLoading = DOM.summaryLoading; const summaryContent = DOM.summaryContent;

// --- Pure utils (testable, no side effects) ---
/** Escape HTML — covers &, <, >, ", ', ` */
function escapeHtml(str) { if (!str) return ''; return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/`/g,'&#96;'); }
/** Debounce with cancel */
function debounce(fn, ms) { let t=null; const d=(...a)=>{ if(t) clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; d.cancel=()=>{ if(t) clearTimeout(t); t=null; }; return d; }
/** Promise wrapper for chrome.storage — validated, lastError aware, size capped */
function storageGet(keys) { try { const p = chrome.storage.local.get(keys); if (p && typeof p.then==='function') return p.catch(e=>{console.warn('[storageGet]',e);return {};}); return new Promise((res)=> chrome.storage.local.get(keys, (r)=>{ if(chrome.runtime.lastError){console.warn('[storageGet]',chrome.runtime.lastError.message); res({});} else res(r||{});})); } catch(e){ console.warn('[storageGet]',e); return Promise.resolve({}); } }
function storageSet(obj) { try { if(!obj||typeof obj!=='object') return Promise.resolve(); for(const k of Object.keys(obj)){ const v=obj[k]; if(typeof v==='string'&&v.length>8000) obj[k]=v.slice(-8000);} const p = chrome.storage.local.set(obj); if (p && typeof p.then==='function') return p.catch(e=>console.warn('[storageSet]',e)); return new Promise((res)=> chrome.storage.local.set(obj, ()=>{ if(chrome.runtime.lastError) console.warn('[storageSet]',chrome.runtime.lastError.message); res();})); } catch(e){ console.warn('[storageSet]',e); return Promise.resolve(); } }
function isValidUrl(s) { try { new URL(s); return true; } catch { return false; } }
function sanitizePromptContext(s) { return String(s||'').trim().slice(0,600).replace(/"""/g,'"\'"').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'').replace(/[ \t]{3,}/g,' ').trim(); }

/**
 * Load persisted suggest context prompt (validated, no throw).
 * @returns {Promise<void>}
 */
async function loadContextPrompt() {
  try {
    const r = await storageGet([CONFIG.STORAGE_KEYS.suggestContextPrompt]);
    const raw = r[CONFIG.STORAGE_KEYS.suggestContextPrompt];
    suggestContextPrompt = typeof raw === 'string' ? raw.slice(0, 600) : '';
    const inp = DOM.contextPromptInput;
    if (inp) { inp.value = suggestContextPrompt; inp.classList.toggle('has-value', !!suggestContextPrompt.trim()); }
    updateContextPromptBadge(false);
    syncState();
  } catch (err) { console.warn('[loadContextPrompt]', err); }
}
/**
 * Persist context prompt with sanitization.
 * @param {unknown} val
 */
async function saveContextPrompt(val) {
  suggestContextPrompt = sanitizePromptContext(val);
  try { await storageSet({ [CONFIG.STORAGE_KEYS.suggestContextPrompt]: suggestContextPrompt }); } catch (e) { console.warn('[saveContextPrompt]', e); }
  syncState();
}
function updateContextPromptBadge(showTemp) {
  const badge = DOM.contextPromptBadge; const inp = DOM.contextPromptInput;
  if (inp) inp.classList.toggle('has-value', !!suggestContextPrompt.trim());
  if (!badge) return;
  if (showTemp && suggestContextPrompt.trim()) {
    badge.style.display = 'inline-block'; badge.textContent = 'Saved';
    clearTimeout(badge._t); badge._t = setTimeout(() => { badge.style.display = 'none'; }, 1800);
  } else if (!suggestContextPrompt.trim()) badge.style.display = 'none';
}
function setupContextPrompt() {
  const inp = DOM.contextPromptInput; const clearBtn = DOM.clearContextPromptBtn;
  const wrap = DOM.contextPromptWrap || document.getElementById('contextPromptWrap');
  const toggle = DOM.contextPromptToggle || document.getElementById('contextPromptToggle');
  const collapsible = DOM.contextPromptCollapsible || document.getElementById('contextPromptCollapsible');
  if (!inp) return;
  // collapsed by default to save dock space; auto-expand if has value
  const hasVal = !!suggestContextPrompt.trim();
  if (wrap && toggle && collapsible) {
    const setCollapsed = (collapsed) => {
      wrap.classList.toggle('collapsed', collapsed);
      toggle.setAttribute('aria-expanded', String(!collapsed));
      collapsible.hidden = collapsed;
      collapsible.style.display = collapsed ? 'none' : 'flex';
    };
    setCollapsed(!hasVal);
    toggle.addEventListener('click', () => {
      const nowCollapsed = wrap.classList.contains('collapsed');
      setCollapsed(!nowCollapsed);
      if (!nowCollapsed === false) onIdle(()=> inp.focus());
    });
    // if user starts typing and wrap is collapsed, auto expand
    inp.addEventListener('focus', () => { if (wrap.classList.contains('collapsed')) setCollapsed(false); });
  }
  const debouncedSave = debounce(async (v) => { await saveContextPrompt(v); updateContextPromptBadge(true); }, 450);
  inp.addEventListener('input', () => {
    const v = inp.value; inp.classList.toggle('has-value', !!v.trim());
    debouncedSave(v);
  });
  inp.addEventListener('blur', async () => { debouncedSave.cancel(); await saveContextPrompt(inp.value); updateContextPromptBadge(true); });
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    debouncedSave.cancel(); inp.value = ''; inp.classList.remove('has-value');
    await saveContextPrompt(''); updateContextPromptBadge(false); inp.focus(); showToast('Context cleared', 'default');
  });
}
function setupDockResizer() {
  const resizer = DOM.dockResizer || document.getElementById('dockResizer');
  const dock = DOM.suggestionDock || document.getElementById('suggestionDock');
  const expandBtn = DOM.dockExpandBtn || document.getElementById('dockExpandBtn');
  if (!resizer || !dock) return;
  // New UI: Answers is a full-area live-view (resizer hidden via CSS).
  // Legacy drag/resize + saved px heights would lock the dock tiny — clear them.
  try { dock.style.maxHeight = ''; dock.style.minHeight = ''; dock.style.height = ''; } catch {}
  try { localStorage.removeItem('dockHeight'); localStorage.removeItem('dockExpanded'); } catch {}
  if (expandBtn) expandBtn.style.display = 'none';
  return;
}

/** Defer non-critical work to idle — keeps first paint <100ms */
function onIdle(fn) { if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 1500 }); else setTimeout(fn, 50); }

/** Lazy-load compromise NLP (343KB) only when needed — never blocks first paint */
let _nlpLoadPromise = null;
function ensureNlpLoaded() {
  try {
    if (typeof window !== 'undefined' && typeof window.nlp === 'function') return Promise.resolve(true);
    if (_nlpLoadPromise) return _nlpLoadPromise;
    _nlpLoadPromise = new Promise((resolve) => {
      try {
        const s = document.createElement('script');
        s.src = 'lib/compromise.min.js';
        s.defer = true;
        s.onload = () => resolve(true);
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
        // safety timeout: never block UI on NLP
        setTimeout(() => resolve(false), 8000);
      } catch { resolve(false); }
    });
    return _nlpLoadPromise;
  } catch { return Promise.resolve(false); }
}

// Initialize — critical first, non-critical idle, no blocking
document.addEventListener('DOMContentLoaded', async () => {
  performance.mark('sidepanel-dom-ready');
  try {
    // Critical path — UI must be interactive immediately
    setupEventListeners(); setupTabNavigation(); setupKeyboardShortcuts(); setupLiveView();
    // Parallel critical storage (small)
    await Promise.all([loadProviderConfig(), loadSuggestPref()]);
    await checkAndHidePermissionOverlay();
    updateWordCounts(); updateDock();
    performance.mark('sidepanel-critical-ready');
    try { performance.measure('sidepanel-critical', 'sidepanel-js-start', 'sidepanel-critical-ready'); } catch {}
  } catch (err) { console.error('[init-critical]', err); showToast('Initialization error', 'error'); }

  // Non-critical — defer to idle so first paint not blocked by 343KB compromise / settings
  onIdle(async () => {
    try {
      setupSettingsOverlay(); setupSummaryFeatures(); setupSuggestToggle(); setupCompressToggle(); setupSuggestionDock(); setupContextPrompt(); setupContextInspector(); setupDockResizer();
      await Promise.all([loadCompressPref(), loadContextPrompt()]);
      updateCompressToggleUI(); updateDock(); updateContextInspector();
      performance.mark('sidepanel-ready');
      try { performance.measure('sidepanel-full', 'sidepanel-js-start', 'sidepanel-ready'); const m = performance.getEntriesByName('sidepanel-full')[0]; if (m) console.log(`[perf] sidepanel full ${m.duration.toFixed(0)}ms`); } catch {}
      // Preload NLP in background after UI is ready (non-blocking)
      onIdle(() => { void ensureNlpLoaded(); });
    } catch (e) { console.warn('[init-idle]', e); }
  });
});

/** @returns {Promise<void>} */
async function loadSuggestPref() {
  try {
    const r = await storageGet([CONFIG.STORAGE_KEYS.suggestEnabled]);
    if (typeof r[CONFIG.STORAGE_KEYS.suggestEnabled] === 'boolean') {
      suggestEnabled = r[CONFIG.STORAGE_KEYS.suggestEnabled];
      if (suggestToggle) suggestToggle.checked = suggestEnabled;
      syncState();
    }
  } catch (e) { console.warn('[loadSuggestPref]', e); }
}
function setupSuggestToggle() {
  if (!suggestToggle) return;
  suggestToggle.addEventListener('change', async () => {
    suggestEnabled = !!suggestToggle.checked;
    syncState();
    try { await storageSet({ [CONFIG.STORAGE_KEYS.suggestEnabled]: suggestEnabled }); } catch (e) { console.warn(e); }
    showToast(suggestEnabled ? 'AI suggestions enabled' : 'AI suggestions disabled', 'default');
  });
}

/** @returns {Promise<void>} */
async function loadCompressPref() {
  try {
    const r = await storageGet([CONFIG.STORAGE_KEYS.compressEnabled, CONFIG.STORAGE_KEYS.compressedSummary, CONFIG.STORAGE_KEYS.lastCompressedIdx]);
    if (typeof r[CONFIG.STORAGE_KEYS.compressEnabled] === 'boolean') { compressEnabled = r[CONFIG.STORAGE_KEYS.compressEnabled]; const t = document.getElementById('compressToggle'); if (t) t.checked = compressEnabled; }
    if (typeof r[CONFIG.STORAGE_KEYS.compressedSummary] === 'string') compressedSummary = r[CONFIG.STORAGE_KEYS.compressedSummary].slice(0, 6000);
    const idxRaw = r[CONFIG.STORAGE_KEYS.lastCompressedIdx]; if (Number.isFinite(Number(idxRaw))) lastCompressedIdx = Math.max(0, Math.floor(Number(idxRaw)));
    syncState(); updateCompressToggleUI(); if (compressEnabled && isListening) startCompressTimer();
  } catch (e) { console.warn('[loadCompressPref]', e); }
}
/** Setup compress toggle — single responsibility, validated storage */
function setupCompressToggle() {
  const el = document.getElementById('compressToggle');
  if (el) el.addEventListener('change', async () => {
    compressEnabled = !!el.checked; syncState();
    try { await storageSet({ [CONFIG.STORAGE_KEYS.compressEnabled]: compressEnabled }); } catch (e) { console.warn(e); }
    updateCompressToggleUI();
    showToast(compressEnabled ? 'History compression enabled (5m)' : 'History compression disabled', 'default');
    if (compressEnabled) {
      startCompressTimer();
      if (finalizedEnPhrases.length - lastCompressedIdx >= 5) void performCompression(false);
    } else stopCompressTimer();
  });
  const manualBtn = document.getElementById('manualCompressBtn');
  if (manualBtn) manualBtn.addEventListener('click', async () => {
    if (!compressEnabled) { showToast('Enable 5m compression before manual compress', 'default'); return; }
    await performCompression(true); updateCompressToggleUI();
  });
}
/** Pure UI update for compress — no side effects beyond DOM */
function updateCompressToggleUI() {
  const el = document.getElementById('compressToggle'); const badge = document.getElementById('compressBadge'); const statusEl = document.getElementById('compressStatus');
  if (el) el.checked = !!compressEnabled;
  if (badge) {
    if (compressedSummary) { badge.textContent = `Compressed ${lastCompressedIdx} sentences`; badge.style.display = 'inline-block'; }
    else { badge.textContent = compressEnabled ? 'Waiting to compress…' : ''; badge.style.display = compressEnabled ? 'inline-block' : 'none'; }
  }
  if (!statusEl) return;
  const pending = Math.max(0, finalizedEnPhrases.length - lastCompressedIdx);
  if (!compressEnabled) { statusEl.style.display = 'none'; return; }
  statusEl.style.display = 'flex';
  if (compressedSummary) { statusEl.classList.add('has-content'); statusEl.textContent = `🗜️ Compressed ${lastCompressedIdx} sentences • ${pending} pending • ${compressedSummary.length} chars`; }
  else if (pending > 0) { statusEl.classList.remove('has-content'); statusEl.textContent = `🗜️ Pending: ${pending} sentences waiting (auto every 5m)`; }
  else { statusEl.classList.remove('has-content'); statusEl.textContent = '🗜️ 5m compression enabled — waiting for transcript…'; }
  const manualBtn = document.getElementById('manualCompressBtn');
  if (manualBtn) { manualBtn.style.display = compressEnabled ? 'inline-block' : 'none'; manualBtn.disabled = !!compressInProgress || pending < 2; manualBtn.title = pending < 2 ? 'Not enough sentences to compress' : `Compress now ${pending} pending sentences`; }
  try { updateContextInspector(); } catch {}
}

/** Context Inspector — show what LLM actually sees (live vs compressed) */
function getContextSnapshot() {
  const en = finalizedEnPhrases;
  const comp = compressedSummary || '';
  const enabled = !!compressEnabled;
  const lastIdx = lastCompressedIdx|0;
  const pending = en.slice(lastIdx);
  const pendingStr = pending.join('\n');
  const total = en.length;
  const pendingCount = pending.length;
  // all questions ever detected — pending tab should show all, not just pending segment
  const allQuestions = en.map((text, idx)=> ({text, idx})).filter(o=> isQuestion(o.text));
  let liveCtx, liveCount;
  if (enabled && comp) {
    const recent = en.slice(-COMPRESS_RECENT_KEEP);
    liveCount = recent.length;
    const recentJoined = recent.join(' | ');
    const recentCtx = recentJoined.length > 1500 ? recentJoined.slice(-1500) : recentJoined;
    const compPreview = comp.length > COMPRESS_MAX_CHARS ? comp.slice(-COMPRESS_MAX_CHARS) : comp;
    liveCtx = `Compressed history (${compPreview.length} chars, will be truncated to ${COMPRESS_MAX_CHARS} max):\n${compPreview || '(none)'}\n\nRecent ${liveCount} utterances (budget 1500 chars):\n${recentCtx || '(empty)'}`;
  } else {
    const recent = en;
    liveCount = recent.length;
    const ctx = recent.join(' | ');
    const truncated = ctx.length > 6000 ? ctx.slice(-6000) : ctx;
    liveCtx = `Conversation history (all ${liveCount} utterances, budget 6000 chars):\n${truncated || '(empty — speak to fill context)'}`;
  }
  return {
    liveCtx,
    compressedPreview: comp || '(no compressed history yet — enable 🗜️ and wait for 5m or click Compress now)',
    pendingSegment: pendingStr || '(nothing pending — all utterances compressed)',
    pendingList: pending,
    allQuestions,
    meta: enabled && comp ? `🗜️ ${comp.length} chars history • ${pendingCount} pending • ${allQuestions.length} questions • live ${liveCount} ctx` : `📝 ${total} total • ${allQuestions.length} questions • live ${liveCount} ctx • ${pendingCount} pending`,
    stats: { total, liveCount, pendingCount, compressedChars: comp.length, lastIdx, allQuestionsCount: allQuestions.length },
  };
}
function updateContextInspector() {
  const metaEl = DOM.inspectorMeta || document.getElementById('inspectorMeta');
  const paneLive = DOM.paneLive || document.getElementById('paneLive');
  const paneComp = DOM.paneCompressed || document.getElementById('paneCompressed');
  const panePending = DOM.panePending || document.getElementById('panePending');
  const snap = getContextSnapshot();
  if (metaEl) metaEl.textContent = snap.meta;
  if (paneLive) paneLive.textContent = snap.liveCtx;
  if (paneComp) paneComp.textContent = snap.compressedPreview;
  if (panePending) {
    const qs = snap.allQuestions || [];
    const pending = snap.pendingList || [];
    if (!qs.length) {
      panePending.textContent = `No questions yet — ${pending.length} pending utterances will be compressed next.\n` + (snap.pendingSegment || '');
    } else {
      const header = `All questions (${qs.length}) — ${pending.length} pending utterances not yet compressed:\n`;
      const list = qs.map((o,i)=> `${i+1}. [#${o.idx+1}] ${o.text}`).join('\n');
      const pendingInfo = pending.length ? `\n\nPending segment (${pending.length}):\n` + pending.map((s,i)=> `${snap.stats.lastIdx+i+1}. ${s}`).join('\n') : '';
      panePending.textContent = header + list + pendingInfo;
    }
  }
}
function setupContextInspector() {
  const toggle = DOM.inspectorToggle || document.getElementById('inspectorToggle');
  const body = DOM.inspectorBody || document.getElementById('inspectorBody');
  const chevron = document.getElementById('inspectorChevron');
  if (!toggle || !body) return;
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    const next = !expanded;
    toggle.setAttribute('aria-expanded', String(next));
    body.hidden = !next;
    body.style.display = next ? 'flex' : 'none';
    if (chevron) chevron.textContent = next ? '▾' : '▸';
    if (next) updateContextInspector();
  });
  document.querySelectorAll('.inspector-tab').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const tab = btn.getAttribute('data-tab');
      document.querySelectorAll('.inspector-tab').forEach(b=>{ b.classList.toggle('active', b===btn); b.setAttribute('aria-selected', b===btn ? 'true':'false'); });
      document.getElementById('paneLive')?.classList.toggle('active', tab==='live');
      document.getElementById('paneCompressed')?.classList.toggle('active', tab==='compressed');
      document.getElementById('panePending')?.classList.toggle('active', tab==='pending');
      if (document.getElementById('paneLive')) document.getElementById('paneLive').hidden = tab!=='live';
      if (document.getElementById('paneCompressed')) document.getElementById('paneCompressed').hidden = tab!=='compressed';
      if (document.getElementById('panePending')) document.getElementById('panePending').hidden = tab!=='pending';
    });
  });
  const copyBtn = DOM.copyContextBtn || document.getElementById('copyContextBtn');
  if (copyBtn) copyBtn.addEventListener('click', async ()=>{
    const activePane = document.querySelector('.inspector-pane.active') || document.getElementById('paneLive');
    const txt = activePane ? activePane.textContent : '';
    try { await navigator.clipboard.writeText(txt); showToast('Context copied','success'); } catch { showToast('Copy failed','error'); }
  });
  // initial
  updateContextInspector();
}

/** @returns {Promise<boolean>} */
async function checkAndHidePermissionOverlay() {
  try {
    const isGranted = await checkMicPermission();
    if (isGranted && permissionOverlay) permissionOverlay.style.display = 'none';
    return !!isGranted;
  } catch (e) { console.warn('[checkAndHidePermissionOverlay]', e); return false; }
}

/**
 * Check mic permission — probe getUserMedia if Permissions API unavailable or unreliable.
 * @returns {Promise<boolean>}
 */
async function checkMicPermission() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    if (status && typeof status.state === 'string') return status.state === 'granted';
  } catch (e) { console.warn('[permissions.query]', e); }
  // Fallback: try enumerateDevices — label is empty without permission, but device existence is hint
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hasInput = devices.some(d => d.kind === 'audioinput');
    // Do not rely on label; if no input at all, definitely false; otherwise probe with 1s timeout
    if (!hasInput) return false;
    // Lightweight probe: request 200ms mic and immediately stop — if fails, not granted
    // We avoid actual getUserMedia here to not trigger prompt; just return false to show overlay
    return false;
  } catch { return false; }
}

// Set up Event Listeners — single responsibility, guarded, no inline alert
function setupEventListeners() {
  if (toggleBtn) toggleBtn.addEventListener('click', toggleListening);
  if (clearBtn) clearBtn.addEventListener('click', () => { void clearContent(); showToast('History cleared', 'success'); });
  if (copyEnBtn) copyEnBtn.addEventListener('click', () => {
    const text = getFullEnglishText(); if (text) void copyToClipboard(text, 'copyEnBtn'); else showToast('No content', 'default');
  });
  if (copyViBtn) copyViBtn.addEventListener('click', () => {
    const text = getFullVietnameseText(); if (text) void copyToClipboard(text, 'copyViBtn'); else showToast('No translation', 'default');
  });
  if (copyAllBtn) copyAllBtn.addEventListener('click', () => {
    const en = getFullEnglishText(); const vi = getFullVietnameseText();
    if (!en && !vi) { showToast('No content', 'default'); return; }
    const combined = `EN:\n${en}\n\nVI:\n${vi}`; void copyToClipboard(combined, 'copyAllBtn');
  });
  if (grantPermissionBtn) grantPermissionBtn.addEventListener('click', openPermissionTab);
  const laterBtn = document.getElementById('permissionLaterBtn');
  if (laterBtn) laterBtn.addEventListener('click', () => { if (permissionOverlay) permissionOverlay.style.display = 'none'; });

  if (transcriptContent) {
    let tick = false;
    transcriptContent.addEventListener('scroll', () => {
      if (tick) return; tick = true;
      requestAnimationFrame(() => {
        tick = false;
        const chk = document.getElementById('autoScrollCheck');
        if (!chk || !chk.checked) { shouldStickToTop = false; return; }
        shouldStickToTop = isNearTop();
      });
    }, { passive: true });
    shouldStickToTop = isNearTop();
    const autoChk = document.getElementById('autoScrollCheck');
    if (autoChk) autoChk.addEventListener('change', () => { shouldStickToTop = !!autoChk.checked; if (autoChk.checked) autoScroll(true); });
  }
  window.addEventListener('focus', async () => {
    try { const g = await checkAndHidePermissionOverlay(); if (g && !isListening && btnText && btnText.innerText === 'Start') showStatus('Ready'); } catch (e) { console.warn('[focus]', e); }
  });
}

/** @returns {void} */
function openPermissionTab() {
  try { chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') }); } catch (e) { console.error('[openPermissionTab]', e); showToast('Failed to open permission page', 'error'); }
}

/** Toggle listening with validated source — no alert, toast only */
async function toggleListening() {
  if (isListening) { stopListening(); return; }
  const source = audioSourceSelect ? audioSourceSelect.value : 'mic';
  if (source === 'tab') { await startTabCapture(); return; }
  const granted = await checkMicPermission();
  if (!granted) { showPermissionOverlay(); return; }
  startListening();
}

/**
 * Promisified sendMessage wrapper
 * @param {object} msg
 * @returns {Promise<any>}
 */
function sendMessageAsync(msg) {
  return new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (resp) => { if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message }); else resolve(resp); }); } catch (e) { resolve({ error: String(e) }); }
  });
}

/** Start tab capture — promise-based, validated, toast, fallback mic */
async function startTabCapture() {
  showStatus('Connecting to Tab audio...');
  const resp = await sendMessageAsync({ type: 'get-tab-stream-id' });
  if (!resp || resp.error || !resp.streamId) {
    const msg = resp && resp.error ? resp.error : 'No response from background';
    console.error('[get-tab-stream-id]', msg); showStatus('Cannot capture this tab.'); showToast(`Cannot capture tab: ${String(msg).slice(0, 160)}`, 'error');
    if (audioSourceSelect) audioSourceSelect.value = 'mic'; return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: resp.streamId } }, video: false });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    window.capturedAudioContext = ctx; window.capturedStream = stream;
    const src = ctx.createMediaStreamSource(stream); window.capturedSource = src; src.connect(ctx.destination);
    const tracks = stream.getAudioTracks();
    if (!tracks.length) throw new Error('No audio tracks');
    activeAudioTrack = tracks[0]; syncState();
    setupSpeakerMonitor(stream);
    startListening();
  } catch (err) {
    console.error('[startTabCapture]', err); showStatus('Tab audio connection error.');
    const detail = err && err.name ? `${err.name}: ${err.message || ''}`.trim() : String(err);
    showToast(`Tab audio failed (${detail.slice(0, 160)}) — switching to Microphone`, 'error');
    if (audioSourceSelect) audioSourceSelect.value = 'mic'; cleanupTabCapture();
    const granted = await checkMicPermission(); if (granted) startListening();
  }
}

/** Cleanup tab capture — idempotent, no throw */
function cleanupTabCapture() {
  try { teardownSpeakerMonitor(); } catch {}
  if (window.capturedStream) { try { window.capturedStream.getTracks().forEach(t => { try { t.stop(); } catch {} }); } catch {} window.capturedStream = null; }
  activeAudioTrack = null; syncState();
  if (window.capturedAudioContext) { try { const ctx = window.capturedAudioContext; if (ctx.state !== 'closed') void ctx.close(); } catch {} window.capturedAudioContext = null; try { if (window.capturedSource) window.capturedSource.disconnect(); } catch {} window.capturedSource = null; }
}

/**
 * Setup speaker monitor — validates stream, isolates AudioContext lifecycle, handles resume errors.
 * @param {MediaStream} stream
 */
function setupSpeakerMonitor(stream) {
  if (!stream || typeof stream.getAudioTracks !== 'function') { console.warn('[setupSpeakerMonitor] invalid stream'); return; }
  if (speakerMonitor && speakerMonitor.stream === stream) return;
  teardownSpeakerMonitor();
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = window.capturedAudioContext || new AudioCtx();
    if (!window.capturedAudioContext) window.capturedAudioContext = ctx;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.35;
    source.connect(analyser);
    const dataFreq = new Uint8Array(analyser.frequencyBinCount);
    const dataTime = new Uint8Array(analyser.fftSize);
    speakerMonitor = { ctx, analyser, dataFreq, dataTime, stream, timer: null, lastRms: 0, lastCentroid: 0, speechStartAt: 0, tickCount: 0, _visHandler: null };
    speakerVadState = 'silence'; speakerVadSilenceMs = 0; syncState();
    let lastTick = performance.now();
    const tick = () => {
      const now = performance.now(); const dt = now - lastTick; lastTick = now;
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!speakerMonitor || speakerMonitor.stream !== stream) return;
      analyser.getByteTimeDomainData(dataTime); analyser.getByteFrequencyData(dataFreq);
      let sum = 0; for (let i = 0; i < dataTime.length; i++) { const v = (dataTime[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / dataTime.length);
      const centroid = computeSpectralCentroid(dataFreq, ctx.sampleRate);
      const isNoise = centroid > 6500 && rms < 0.08;
      const isSpeech = rms > CONFIG.SPEAKER_VAD_RMS_THRESH && !isNoise;
      speakerMonitor.tickCount = (speakerMonitor.tickCount||0)+1;
      if (isSpeech) {
        if (speakerVadState === 'silence') {
          const pauseLen = speakerVadSilenceMs; speakerVadState = 'speech';
          if (speakerMonitor) speakerMonitor.speechStartAt = now;
          if (pauseLen >= CONFIG.SPEAKER_MIN_PAUSE_MS && lastSpeakerFeatures) {
            const feats = { rms, centroid };
            if (shouldToggleSpeaker(feats, pauseLen)) { currentSpeakerId = (currentSpeakerId + 1) % 2; syncState(); maybeCutLiveOnSpeakerChange(); }
            lastSpeakerFeatures = feats;
          } else if (!lastSpeakerFeatures) lastSpeakerFeatures = { rms, centroid };
        } else if (lastSpeakerFeatures) {
          const alpha=0.15; lastSpeakerFeatures.rms = lastSpeakerFeatures.rms * (1-alpha) + rms * alpha; lastSpeakerFeatures.centroid = lastSpeakerFeatures.centroid * (1-alpha) + centroid * alpha;
        }
        speakerVadSilenceMs = 0;
      } else {
        if (speakerVadState === 'speech') {
          const speechDur = speakerMonitor.speechStartAt ? now - speakerMonitor.speechStartAt : 0;
          if (speechDur < CONFIG.SPEAKER_MIN_SPEECH_MS && rms <= CONFIG.SPEAKER_VAD_RMS_THRESH) { /* keep speech briefly */ } else speakerVadState = 'silence';
        }
        speakerVadSilenceMs += dt;
      }
      if (speakerMonitor) { speakerMonitor.lastRms = rms; speakerMonitor.lastCentroid = centroid; }
    };
    speakerMonitor.timer = setInterval(tick, 120);
    const onVis = () => { if (typeof document!=='undefined' && document.hidden && speakerMonitor?.timer) { clearInterval(speakerMonitor.timer); speakerMonitor.timer=null; } else if (!document.hidden && speakerMonitor && !speakerMonitor.timer) speakerMonitor.timer=setInterval(tick,120); };
    if (typeof document!=='undefined') document.addEventListener('visibilitychange', onVis);
    if (speakerMonitor) speakerMonitor._visHandler=onVis;
    syncState();
  } catch (e) { console.warn('[setupSpeakerMonitor]', e); }
}
/** Teardown monitor — idempotent, clears interval, suspends context */
function teardownSpeakerMonitor() {
  if (speakerMonitor && speakerMonitor.timer) { clearInterval(speakerMonitor.timer); speakerMonitor.timer = null; }
  if (speakerMonitor && speakerMonitor._visHandler && typeof document!=='undefined') try{ document.removeEventListener('visibilitychange', speakerMonitor._visHandler);}catch{}
  if (speakerMonitor && speakerMonitor.ctx && speakerMonitor.ctx.state === 'running') { try { void speakerMonitor.ctx.suspend(); } catch {} }
  speakerMonitor = null; speakerVadState = 'silence'; speakerVadSilenceMs = 0; syncState();
}
/**
 * Pure: compute spectral centroid
 * @param {Uint8Array} freqData
 * @param {number} sampleRate
 * @returns {number}
 */
function computeSpectralCentroid(freqData, sampleRate) {
  if (!freqData || !freqData.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  const nyquist = sampleRate / 2; const binHz = nyquist / freqData.length;
  let sumAmp = 0, sumWeighted = 0;
  for (let i = 0; i < freqData.length; i++) { const amp = freqData[i] / 255; if (amp < 0.02) continue; sumAmp += amp; sumWeighted += amp * (i * binHz); }
  return sumAmp > 0 ? sumWeighted / sumAmp : 0;
}
/**
 * Decide speaker toggle — pure except debounce timestamp.
 * @param {{rms:number,centroid:number}} feats
 * @param {number} pauseLen
 * @returns {boolean}
 */
function shouldToggleSpeaker(feats, pauseLen) {
  if (!feats || !lastSpeakerFeatures) return false;
  const now = performance.now(); if (now - speakerVadLastSwitchAt < 900) return false;
  const rmsDiff = Math.abs(feats.rms - lastSpeakerFeatures.rms);
  const centDiff = Math.abs(feats.centroid - lastSpeakerFeatures.centroid);
  const centThresh = pauseLen > 700 ? CONFIG.SPEAKER_CENTROID_DIFF * 0.75 : CONFIG.SPEAKER_CENTROID_DIFF;
  const rmsThresh = 0.04;
  if (centDiff > centThresh) { speakerVadLastSwitchAt = now; syncState(); return true; }
  if (rmsDiff > rmsThresh && centDiff > centThresh * 0.6) { speakerVadLastSwitchAt = now; syncState(); return true; }
  return false;
}
/** Cut live utterance on speaker change — guarded, no throw */
function maybeCutLiveOnSpeakerChange() {
  const lastCache = utteranceDomCache[utteranceDomCache.length - 1];
  if (!lastCache || !lastCache.isLive) return;
  const liveText = lastCache.enText ? String(lastCache.enText.textContent || '').trim() : '';
  if (!liveText) return;
  const rawLen = finalizedOffset + liveText.length;
  void forceFinalizeText(liveText, rawLen);
}

/** Show overlay — guarded */
function showPermissionOverlay() {
  if (!permissionOverlay) return;
  permissionOverlay.style.display = 'flex'; showStatus('Microphone permission required');
}

/** Start listening — resets session state, handles track fallback, no unhandled rejection */
function startListening() {
  if (!recognition) initRecognition();
  if (!recognition) { showToast('Browser does not support Speech Recognition', 'error'); return; }
  try {
    lastFinalIndex = -1; finalizedOffset = 0; syncState();
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; syncState(); }
    if (activeAudioTrack) {
      try { recognition.start(activeAudioTrack); } catch (e) {
        console.warn('[startListening] track start failed, fallback mic', e);
        activeAudioTrack = null; syncState(); recognition.start();
      }
    } else {
      void setupMicSpeakerMonitor().catch(() => {});
      recognition.start();
    }
  } catch (e) { console.error('[startListening]', e); showToast('Failed to start recording', 'error'); }
}

/** Mic monitor for speaker diarization — best-effort, silent fail */
async function setupMicSpeakerMonitor() {
  if (speakerMonitor || window.capturedStream) return;
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    window.micMonitorStream = micStream; setupSpeakerMonitor(micStream);
  } catch (e) { console.warn('[setupMicSpeakerMonitor]', e.message || e); }
}

/** Stop listening — idempotent, aborts all async, syncs state */
function stopListening() {
  isListening = false; syncState();
  if (recognition) { try { recognition.stop(); } catch (e) { console.warn('[stopListening] stop', e); } }
  if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; syncState(); }
  if (liveViDebounce) { clearTimeout(liveViDebounce); liveViDebounce = null; }
  if (liveViController) { try { liveViController.abort(); } catch {} liveViController = null; }
  abortAllPendingTranslations(); teardownSpeakerMonitor();
  if (window.micMonitorStream) { try { window.micMonitorStream.getTracks().forEach(t => { try { t.stop(); } catch {} }); } catch {} window.micMonitorStream = null; }
  cleanupTabCapture(); stopCompressTimer(); updateUIForListening(false); showStatus('Stopped');
}

/**
 * Initialize SpeechRecognition — validates API, isolates handlers, syncs state.
 * @returns {void}
 */
function initRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { showStatus('Browser does not support Speech Recognition.'); showToast('Browser does not support SpeechRecognition', 'error'); return; }
  const rec = new SpeechRecognition();
  rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
  rec.onstart = handleRecognitionStart;
  rec.onresult = handleRecognitionResult;
  rec.onerror = handleRecognitionError;
  rec.onend = handleRecognitionEnd;
  recognition = rec; syncState();
}
/** @returns {void} */
function handleRecognitionStart() {
  isListening = true; syncState(); updateUIForListening(true);
  showStatus(activeAudioTrack ? 'Translating Tab audio...' : 'Listening for English (Mic)...');
  if (compressEnabled) startCompressTimer();
}
/**
 * Pure helper to extract interim/final from event — validated, deduped, low-confidence filter.
 * @param {SpeechRecognitionEvent} event
 * @returns {{interimEn:string, finals:string[]}}
 */
function parseRecognitionEvent(event) {
  let interimEn = ''; const finals = [];
  if (!event || !event.results || typeof event.resultIndex !== 'number') return { interimEn:'', finals };
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const r = event.results[i];
    if (!r || !r[0]) continue;
    const conf = r[0].confidence;
    if (r.isFinal) {
      if (i > lastFinalIndex) {
        lastFinalIndex = i; syncState();
        const raw = String(r[0].transcript || '');
        if (!raw.trim() || /^[\s\.\,\!\?\-]+$/.test(raw)) { finalizedOffset=0; syncState(); continue; }
        if (Number.isFinite(conf) && conf < 0.25) { finalizedOffset=0; syncState(); continue; }
        const remaining = raw.substring(finalizedOffset).trim();
        finalizedOffset = 0; syncState();
        if (remaining && finals[finals.length-1] !== remaining) finals.push(remaining);
      }
    } else {
      const raw = String(r[0].transcript || '');
      if (finalizedOffset > raw.length) { finalizedOffset = raw.length; syncState(); }
      interimEn = raw.substring(finalizedOffset).trim();
      if (interimEn.length>200) interimEn=interimEn.slice(-200);
    }
  }
  return { interimEn, finals };
}
/** @param {SpeechRecognitionEvent} event */
function handleRecognitionResult(event) {
  if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; syncState(); }
  const { interimEn, finals } = parseRecognitionEvent(event);
  for (const f of finals) void finalizeText(f).catch(e => console.error('[finalizeText]', e));
  if (!interimEn) return;
  hidePlaceholders();
  const liveCache = ensureLiveUtterance();
  if (liveCache && liveCache.enText && liveCache.enText.textContent !== interimEn) { liveCache.enText.textContent = interimEn; liveCache.enText.classList.add('typing'); }
  autoScroll(false, 'instant'); debouncedTranslateInterim(interimEn);
  const lastIdx = event.results.length - 1; const curLen = event.results[lastIdx] ? String(event.results[lastIdx][0].transcript || '').length : interimEn.length;
  if (interimEn.length >= CONFIG.MAX_INTERIM_LENGTH) void forceFinalizeText(interimEn, curLen).catch(()=>{});
  else { silenceTimer = setTimeout(() => { void forceFinalizeText(interimEn, curLen).catch(()=>{}); }, CONFIG.SILENCE_THRESHOLD); syncState(); }
}
/** @param {SpeechRecognitionErrorEvent} event */
function handleRecognitionError(event) {
  const err = event && event.error ? String(event.error) : 'unknown';
  console.error('[recognition.error]', err);
  if (err === 'not-allowed' || err === 'service-not-allowed') { showPermissionOverlay(); stopListening(); }
  else if (err === 'no-speech' || err === 'aborted') { /* ignore */ }
  else if (err === 'audio-capture') { showToast('Mic not found — check device','error'); showStatus('Mic error'); stopListening(); }
  else if (err === 'network') { showToast('STT network error — retrying','error'); showStatus('STT network error'); }
  else { showStatus(`Error: ${err}`); showToast(`Recording error: ${err}`, 'error'); stopListening(); }
}
/** @returns {void} */
function handleRecognitionEnd() {
  if (isListening) {
    try {
      lastFinalIndex = -1; finalizedOffset = 0; syncState();
      const rec = recognition;
      if (!rec) throw new Error('no rec');
      setTimeout(() => {
        try { if (activeAudioTrack) rec.start(activeAudioTrack); else rec.start(); } catch (e) { console.error('[auto-restart]', e); showToast('Auto-restart failed', 'error'); stopListening(); }
      }, 300);
    } catch (e) { console.error('[auto-restart]', e); showToast('Auto-restart failed', 'error'); }
  } else updateUIForListening(false);
}
  
// Hoisted regexes — compiled once, pure (improved 2026-09-20)
const RE_WH_START = /^(who|what|when|where|why|how|which|whom|whose|whether|what's|how's|where's|when's|who's|why's)\b/i;
const RE_WH_ABOUT = /^(what about|how about)\b/i;
const RE_CASUAL_Q = /^(wanna|lemme|gimme|dunno)\b/i;
const RE_AUX_START = /^(is|are|was|were|am|be|been|being|do|does|did|can|could|will|would|shall|should|may|might|must|have|has|had|ought|need|dare|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|cannot|won't|wouldn't|shouldn't|hasn't|haven't|hadn't|is there|are there|was there|were there|have there|has there|what's|how's|where's|who's)\b/i;
const RE_TAG_Q = /,\s*(right|correct|isn't it|aren't you|don't you|doesn't it|doesn't he|doesn't she|didn't you|won't you|wouldn't you|haven't you|hasn't he|is it|are you|wasn't it|weren't you|okay|ok|yeah|yep|huh)\s*\??\s*$/i;
const RE_TAG_Q_NOCOMMA = /\b(right|okay|ok|yeah|yep|huh)\s*\??\s*$/i;
const RE_EMBEDDED = /\b(do you|does he|does she|do they|did you|did he|did she|are you|is he|is she|are they|is there|are there|was there|were there|can you|could you|would you|will you|shall we|should you|should we|have you|has he|has she|had you|am i|would you mind|could you please|can you please|will you please|do you know|do you think|have you ever|would you like|could you tell|can you tell|are you going|is he going|will you be|have you been|has anyone|did anyone|did you ever|could you kindly|would you kindly|how are you|how is it|what do you|where are you|when are you|why are you|who are you)\b/i;
const RE_INDIRECT = /^(do you know|can you tell|would you mind|could you explain|have you ever|are you familiar|do you think|would you say|is there any|are there any|tell me|let me know|any idea|anyone know|anybody know|everyone know|any chance|could you share|would you happen|i was wondering if|wondering if|any chance you could|is there a chance)\b/i;
const RE_WONDERING = /\b(i was wondering if|i wonder if|wondering if|do you mind if|would you mind if)\b/i;
const RE_POLITE = /\b(could you maybe|would you maybe|could you kindly|would you kindly|would you please|could you please|would you be able to|could you be able to|could you just|would you just)\b/i;
const RE_TRAILING_OR = /\b(or not|or what|or something|or anything|or somewhere)\s*$/i;
const RE_DECLARATIVE_FALSE = /^(this|that|these|those|it|we|they|he|she|you)\s+(is|are|was|were|have|has|had|will|would|can|could|should)\b/i;
const RE_WH_SUBORDINATE = /^(who|what|when|where|why|how|which|whom|whose|whether)\s+(someone|somebody|something|somewhere|someone's|somebodys|anyone|anybody|anything|anywhere|everyone|everybody|everything|people|they|he|she|it|we|you|one|someone|something)\s+(is|are|was|were|will|would|can|could|should|have|has|had|do|does|did|be|been|being|is likely|are likely|was likely)\b/i;
const RE_IMPERATIVE_DO = /^(do|does|did)\s+(this|that|these|those|it)\b/i;
const RE_AUX_STRICT = /^(is|are|was|were|am|be|been|being|do|does|did|can|could|will|would|shall|should|may|might|must|have|has|had|ought|need|dare|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|cannot|won't|wouldn't|shouldn't|hasn't|haven't|hadn't)\s+(you|he|she|they|we|i|it|there|one|anyone|anybody|everyone|someone|somebody|this|that|these|those)\b/i;

function normalizeForQuestion(raw){
  let s=String(raw||'').trim();
  s=s.replace(/^[a-z]\s+(?=(?:who|what|when|where|why|how|which|whom|whose|whether|okay|ok|yeah|yep|right|how's|what's|where's)\b)/i,'');
  if(/^[a-z]\s+\w/i.test(s) && !/^[IA]\s/i.test(s) && s.split(/\s+/).length>=2){
    const parts=s.split(/\s+/);
    if(parts[0].length===1 && parts[1].length>=2) s=s.replace(/^[a-z]\s+/i,'');
  }
  s=s.replace(/\b(you)estion\b/gi,'$1');
  s=s.replace(/\b(how)estion\b/gi,'$1');
  s=s.replace(/\b(what)estion\b/gi,'$1');
  s=s.replace(/\bwanna\b/gi,'want to');
  s=s.replace(/\bgonna\b/gi,'going to');
  s=s.replace(/\bgotta\b/gi,'got to');
  s=s.replace(/\blemme\b/gi,'let me');
  s=s.replace(/\bgimme\b/gi,'give me');
  s=s.replace(/\s+/g,' ').trim();
  return s;
}
const RE_Q_START_SIDE = /^(who|what|when|where|why|how|which|whom|whose|whether|what's|how's|where's|when's|who's|why's|is|are|was|were|am|be|been|being|do|does|did|can|could|will|would|shall|should|may|might|must|have|has|had|ought|need|dare|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|cannot|won't|wouldn't|shouldn't|hasn't|haven't|hadn't)\b/i;

/**
 * Detect question — multi-layer + optional compromise, pure-ish, hoisted regex, validated.
 * @param {unknown} text
 * @returns {boolean}
 */
function isQuestion(text) {
  const rawIn = (text || '').trim();
  if (!rawIn) return false;
  if (rawIn.length < 3) return false;
  if (rawIn.includes('?')) return true;
  if (RE_CASUAL_Q.test(rawIn.trim())) return true;
  const raw = normalizeForQuestion(rawIn);
  if (raw.includes('?')) return true;
  if (!raw || raw.length < 3) return false;

  const t = raw.replace(/\s+/g, ' ').trim();
  const lower = t.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const wc = words.length;
  if (wc < 2) return false;
  if (/\b(to|for|with|of|in|on|at|a|an|the)\s*$/i.test(t)) return false;

  // Library first (if loaded): compromise (lazy-loaded, never blocks UI)
  try {
    const nlpFn = (typeof window !== 'undefined' && window.nlp) ? window.nlp : (typeof self !== 'undefined' && self.nlp ? self.nlp : null);
    if (typeof nlpFn === 'function') {
      const doc = nlpFn(t);
      // compromise 14+: doc.questions() or doc.sentences().isQuestion()
      if (doc && typeof doc.questions === 'function') {
        const qs = doc.questions();
        if (qs && qs.found) return true;
        // also check json for question flag
        if (qs && typeof qs.length === 'number' && qs.length > 0) return true;
      }
      // Fallback via terms: check if first term is WH or aux + inversion
      // we keep heuristic below even if nlp exists
    } else {
      // NLP not loaded yet — load in background for next questions (heuristics below still work now)
      try { void ensureNlpLoaded(); } catch {}
    }
  } catch (_) {}

  if (t.endsWith('!')) {
    if (/^what\s+a(n)?\b/i.test(t)) return false;
    if (/^how\s+(wonderful|nice|great|beautiful|amazing|lovely|good|bad|terrible).*!\s*$/i.test(t)) return false;
    if (/^what\s+a\b/.test(t)) return false;
  }
  // Fast-speech comma-concat: "How are you, Today I will..."
  const commaIdx = t.indexOf(',');
  if (commaIdx > 0) {
    const left = t.slice(0, commaIdx).trim();
    const leftWords = left.split(/\s+/).filter(Boolean).length;
    if (leftWords >= 2 && leftWords <= 12) {
      const leftLower = left.toLowerCase();
      if (RE_WH_START.test(left) || RE_AUX_START.test(left) || RE_EMBEDDED.test(leftLower) || RE_TAG_Q.test(left)) {
        const right = t.slice(commaIdx + 1).trim();
        if (right && /^[A-Z]/.test(right)) return true;
        if (RE_WH_START.test(left) || RE_AUX_START.test(left)) return true;
      }
    }
  }
  function isNoCommaTag(s, wordCount){
    if(!RE_TAG_Q_NOCOMMA.test(s)||wordCount<3) return false;
    if(/\b(are|is|was|were)\s+right\s*\??\s*$/i.test(s) && !/,\s*right\s*\??\s*$/i.test(s)){
      if(/^(i think|you are|he is|she is|it is|we are|they are)\b/i.test(s.trim()) || /\bthink\s+you\s+are\s+right\s*$/i.test(s)) return false;
      if(/^\w+\s+(is|are|was|were)\s+right\s*$/i.test(s.trim())) return false;
    }
    if(/^this\s+is\s+correct\s*$/i.test(s)||/^that\s+is\s+correct\s*$/i.test(s)) return false;
    return true;
  }
  const hasTag = RE_TAG_Q.test(t) || isNoCommaTag(t, wc);
  const startsDeclarative = RE_DECLARATIVE_FALSE.test(t) && !hasTag && !RE_TRAILING_OR.test(t) && !RE_EMBEDDED.test(t);
  if (startsDeclarative && !RE_WH_START.test(t) && !RE_AUX_START.test(t)) return false;

  if (RE_WH_ABOUT.test(t) && wc >= 2 && !t.endsWith('!')) return true;
  if (RE_CASUAL_Q.test(t) && wc >= 2) return true;
  if (RE_IMPERATIVE_DO.test(t) && !RE_TAG_Q.test(t) && !RE_TRAILING_OR.test(t) && !t.includes('?')) {
    if (/^(do|does|did)\b/i.test(t)) {
      if (!/\b(you|we|they|he|she|it|there)\b/i.test(t.split(/\s+/).slice(0,4).join(' '))) {
        // imperative declarative, skip WH/AUX fast path, let later strict aux handle
      } else {}
    }
  } else if (RE_WH_START.test(t)) {
    if (RE_WH_SUBORDINATE.test(t)) {
      // subordinate noun clause, not a standalone question
    } else if (wc >= 2 && !t.endsWith('!')) return true;
  }
  if (RE_AUX_START.test(t) && wc >= 2) {
    const auxWord = t.split(/\s+/)[0].toLowerCase();
    const needsSubject = /^(do|does|did|can|could|will|would|shall|should|may|might|must|have|has|had)\b/i.test(auxWord);
    if (needsSubject) {
      const isDo = /^(do|does|did)\b/i.test(auxWord);
      if (isDo) {
        if (/^(do|does|did)\s+(you|he|she|they|we|i|it|there|one|anyone|anybody|everyone|someone|somebody)\b/i.test(t)) return true;
        if (/^(is there|are there|was there|were there)\b/i.test(t)) return true;
      } else {
        if (RE_AUX_STRICT.test(t)) return true;
        if (/^(is there|are there|was there|were there)\b/i.test(t)) return true;
      }
    } else {
      return true;
    }
  }
  if (RE_TAG_Q.test(t)) return true;
  if (isNoCommaTag(t, wc)) return true;
  if (RE_EMBEDDED.test(t) && wc >= 4) return true;
  if (RE_WONDERING.test(t) && wc >= 4) return true;
  if (RE_POLITE.test(t) && wc >= 4) return true;
  if (RE_INDIRECT.test(lower) && wc >= 3) return true;
  if (RE_TRAILING_OR.test(t) && wc >= 4) return true;

  return false;
}

// === AI supplement for question detection (cost-controlled) ===
const AI_DETECT_CACHE = new Set(); // dedup by text hash to avoid duplicate LLM calls
function _aiCacheKey(t){ return String(t||'').trim().toLowerCase().slice(0,120); }
function shouldTriggerAiSplitSide(text){
  const t=String(text||'').trim(); if(!t||t.length<15) return false;
  const words=t.toLowerCase().split(/\s+/).filter(Boolean); if(words.length<6) return false;
  const termCount=(t.match(/[.!?]+/g)||[]).length; if(termCount>=2) return false;
  const lower=t.toLowerCase();
  const whCount=(lower.match(/\b(who|what|when|where|why|how|which|whom|whose|whether)\b/gi)||[]).length;
  const auxCount=(lower.match(/\b(is|are|was|were|am|be|been|being|do|does|did|can|could|will|would|shall|should|may|might|must|have|has|had|ought|need|dare)\b/gi)||[]).length;
  if(whCount>=2) return true;
  if(auxCount>=2 && words.length>=7) return true;
  if(whCount>=1 && auxCount>=1 && words.length>=8){
    const re=/\b(who|what|when|where|why|how|which|is|are|was|were|am|do|does|did|can|could|will|would|shall|should|have|has|had)\b/gi;
    const markers=[]; let m; while((m=re.exec(lower))!==null) markers.push(m.index);
    if(markers.length>=2 && markers[1]-markers[0]>12) return true;
  }
  if(words.length>=6){
    const emb=lower.search(/\b(do you|does he|does she|do they|did you|are you|is he|is she|are they|is there|are there|can you|could you|will you|would you|have you|has anyone|how many|what is|where are|who are|which one)\b/i);
    if(emb>12 && emb < lower.length -10){
      const prefixWords=lower.slice(0,emb).trim().split(/\s+/).filter(Boolean).length;
      const suffixWords=lower.slice(emb).trim().split(/\s+/).filter(Boolean).length;
      if(prefixWords>=2 && suffixWords>=3) return true;
    }
  }
  return false;
}
function shouldTriggerAiFalseNegativeSide(text, localIsQ){
  if(localIsQ) return false; const t=String(text||'').trim(); if(!t) return false;
  const words=t.toLowerCase().split(/\s+/).filter(Boolean); if(words.length<5||words.length>22) return false;
  if(t.includes('?')) return false;
  if(/\b(wondering if|do you mind|any idea|any chance|tell me|let me know|anyone know)\b/i.test(t)) return true;
  if(/\b(or not|or what|right|okay|yeah|huh)\s*$/i.test(t) && words.length>=4) return true;
  if(words.length>=6 && /\b(do you|are you|is there|can you|could you|would you|have you|has anyone)\b/i.test(t.toLowerCase())) return true;
  return false;
}
function shouldTriggerAiDetectSide(text, localIsQ){ return shouldTriggerAiSplitSide(text) || shouldTriggerAiFalseNegativeSide(text, localIsQ); }
function buildAiDetectPromptSide(text){
  const safe=sanitizePromptContext(String(text||'').slice(0,800));
  const prompt=`You are a question extractor for live English meeting transcripts.\n\nTask: Given a transcript block, extract all distinct questions. Return JSON only.\n\nInput block: """${safe}"""\n\nRules:\n- Split on missing punctuation too (e.g. "Where are you from where were you born" -> 2 questions).\n- Extract ONLY the question part, exclude declarative statements. Example: "Four of us do you have any siblings" -> ["do you have any siblings"] (exclude "Four of us").\n- Keep each question as a complete sentence (3-20 words), without trailing "?".\n- If block has no question, return empty array.\n- If block has 1 question, return array with 1 element.\n- If block has 2-4 questions, return each as separate element.\n- Do NOT hallucinate: only use words from input block.\n\nOutput ONLY JSON: {"questions":["question 1","question 2"]}`;
  const systemPrompt='You are a precise question extractor. Output ONLY JSON with "questions" array. No markdown.';
  return {prompt, systemPrompt};
}
function parseAiDetectResponseSide(raw){
  if(!raw||typeof raw!=='string') return []; let s=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/i,'').trim();
  try{ const m=s.match(/\{[\s\S]*\}/); if(m){ const obj=JSON.parse(m[0].replace(/,\s*([}\]])/g,'$1')); if(obj&&Array.isArray(obj.questions)) return obj.questions.slice(0,4).map(q=>String(q).trim()).filter(q=>q.length>=5&&q.length<=200).map(q=>q.replace(/\s+/g,' ').trim()); if(Array.isArray(obj)) return obj.slice(0,4).map(q=>String(q).trim()).filter(Boolean);} }catch(_){}
  try{ const m2=s.match(/\[[\s\S]*\]/); if(m2){ const arr=JSON.parse(m2[0].replace(/,\s*([}\]])/g,'$1')); if(Array.isArray(arr)) return arr.slice(0,4).map(q=>String(q).trim()).filter(Boolean);} }catch(_){}
  return [];
}
function validateAiQuestionsSide(original, questions){
  if(!Array.isArray(questions)||questions.length===0) return [];
  const origLower=String(original||'').toLowerCase(); const origWords=new Set(origLower.split(/\s+/).filter(Boolean)); const out=[];
  for(const q of questions){ const t=String(q).trim(); if(!t||t.length<5||t.length>250) continue; if(!isQuestion(t) && t.split(/\s+/).filter(Boolean).length <6){ if(!/\b(do you|are you|is there|can you|could you|will you|have you|where|what|how|who|when|why)\b/i.test(t)) continue; } const qWords=t.toLowerCase().split(/\s+/).filter(Boolean); let hit=0; for(const w of qWords) if(origWords.has(w)) hit++; if(qWords.length>=3 && hit/qWords.length<0.5) continue; if(out.includes(t)) continue; out.push(t); }
  const hasRealQ=out.some(q=> isQuestion(q));
  let filtered=hasRealQ ? out.filter(q=> isQuestion(q) || q.split(/\s+/).length >=5) : out;
  if(filtered.length>=2){ const joinedLen=filtered.join(' ').length; const origLen=String(original).trim().length; if(joinedLen<origLen*0.4||joinedLen>origLen*1.5){ const best=filtered.find(q=> isQuestion(q)); return best ? [best] : []; } }
  if(filtered.length===1 && String(original).trim().length > filtered[0].length +8){ if(!isQuestion(filtered[0])) return []; }
  return filtered.slice(0,4);
}
async function detectQuestionsViaAiSide(text){
  const t=String(text||'').trim(); if(!t) return [];
  if(!providerConfig||!providerConfig.baseUrl||!providerConfig.model) return [];
  const isLocal=String(providerConfig.baseUrl).includes('localhost')||String(providerConfig.baseUrl).includes('127.0.0.1');
  if(!providerConfig.apiKey&&!isLocal) return [];
  const key=_aiCacheKey(t); if(AI_DETECT_CACHE.has(key)) return []; // already tried
  AI_DETECT_CACHE.add(key); if(AI_DETECT_CACHE.size>200){ const first=AI_DETECT_CACHE.values().next().value; AI_DETECT_CACHE.delete(first); }
  const {prompt, systemPrompt}=buildAiDetectPromptSide(t);
  const raw=await callProviderGeneric(prompt,{temperature:0.2,maxTokens:256,systemPrompt});
  const parsed=parseAiDetectResponseSide(raw);
  return validateAiQuestionsSide(t,parsed);
}
async function splitUtteranceAtSide(idx, newQs){
  if(!Array.isArray(newQs)||newQs.length<2) return false;
  const oldLen=finalizedEnPhrases.length; if(idx<0||idx>=oldLen) return false;
  // prevent infinite: if newQs combined equals old roughly and each valid
  const oldText=finalizedEnPhrases[idx];
  // splice arrays
  const speaker=utteranceSpeakers[idx]!==undefined?utteranceSpeakers[idx]:currentSpeakerId;
  finalizedEnPhrases.splice(idx,1,...newQs);
  finalizedViPhrases.splice(idx,1,...newQs.map(_=>'…'));
  utteranceSpeakers.splice(idx,1,...newQs.map(_=>speaker));
  // splice DOM cache: remove old root, insert new ones
  // shift suggestion map + selected idx
  const shift=newQs.length-1;
  // remap questionSuggestions > idx
  const nextQ={}; for(const k of Object.keys(questionSuggestions)){ const ki=Number(k); if(ki<idx) nextQ[ki]=questionSuggestions[ki]; else if(ki===idx) {/* drop old */} else if(ki>idx) nextQ[ki+shift]=questionSuggestions[ki]; }
  questionSuggestions=nextQ;
  if(selectedQuestionIdx!==null){
    if(selectedQuestionIdx===idx) selectedQuestionIdx=null;
    else if(selectedQuestionIdx>idx) selectedQuestionIdx+=shift;
  }
  // remap compress pointer
  if(lastCompressedIdx>idx) lastCompressedIdx+=shift;
  // DOM: remove old root if exists
  const oldCache=utteranceDomCache[idx];
  if(oldCache&&oldCache.root&&oldCache.root.parentNode){ try{ oldCache.root.remove(); }catch{} }
  // rebuild cache array: splice
  utteranceDomCache.splice(idx,1);
  // insert new DOMs sequentially; due to prepend (newest on top) we need to insert in reverse visual order
  // simplest: rebuild all after idx by recreating via appendUtterance for new indices, then reindex remaining
  // create new caches for newQs
  const newCaches=[];
  for(let i=0;i<newQs.length;i++){
    const nIdx=idx+i;
    const en=newQs[i]; const vi='…';
    // temporarily set arrays already spliced, so build
    const cache=buildUtteranceDom(nIdx,en,vi);
    cache._speakerId=speaker; applySpeakerToDom(cache,speaker);
    newCaches.push(cache);
  }
  utteranceDomCache.splice(idx,0,...newCaches);
  // reindex all after idx+newQs.length
  for(let i=idx+newQs.length;i<utteranceDomCache.length;i++){ const c=utteranceDomCache[i]; if(c&&c.root) c.root.dataset.index=i; }
  // also reindex before idx stays
  for(let i=0;i<idx;i++){ const c=utteranceDomCache[i]; if(c&&c.root) c.root.dataset.index=i; }
  // translate new utterances
  const tasks=[]; for(let i=0;i<newQs.length;i++){ const nIdx=idx+i; tasks.push({idx:nIdx,text:newQs[i],cache:utteranceDomCache[nIdx]}); }
  // fire translate without blocking caller
  translateBatchConcurrent(tasks, MAX_CONCURRENT_TRANSLATE).catch(()=>{});
  // trigger suggest for each new question
  for(let i=0;i<newQs.length;i++){ const nIdx=idx+i; const q=newQs[i]; if(isQuestion(q)) triggerSuggestForIndex(nIdx,q); }
  syncState(); updateDock(); try{ updateContextInspector(); }catch{}
  autoScroll(true);
  return true;
}
async function handleAiVerifyForIndexSide(idx, originalText){
  try{
    const localIsQ=isQuestion(originalText);
    if(!shouldTriggerAiDetectSide(originalText, localIsQ)) return;
    const qs=await detectQuestionsViaAiSide(originalText);
    if(!qs||qs.length===0) return;
    // false negative: local false but AI found 1
    if(!localIsQ && qs.length===1){
      const q=qs[0]; if(q&&q.length>=5) { triggerSuggestForIndex(idx,q); const cc=utteranceDomCache[idx]; if(cc&&cc.root) cc.root.classList.add('question'); }
      return;
    }
    // declarative+question: AI extracted pure question shorter than original (e.g. "Four of us do you have any siblings" -> ["do you have any siblings"])
    if(qs.length===1 && localIsQ && isQuestion(qs[0]) && originalText.length > qs[0].length + 8){
      const q=qs[0];
      const lowerOrig=originalText.toLowerCase();
      const lowerQ=q.toLowerCase();
      let start=lowerOrig.indexOf(lowerQ);
      if(start===-1){
        const fw=lowerQ.split(/\s+/).slice(0,2).join(' ');
        start=lowerOrig.indexOf(fw);
      }
      if(start>4){
        const prefix=originalText.slice(0,start).trim().replace(/,\s*$/,'').replace(/^,\s*/,'');
        if(prefix && prefix.split(/\s+/).length>=2 && prefix.length>=4){
          await splitUtteranceAtSide(idx, [prefix, q]);
          return;
        }
      }
    }
    if(qs.length>=2){
      const validQs=qs.filter(q=> isQuestion(q) || q.split(/\s+/).filter(Boolean).length>=4 );
      if(validQs.length>=2) await splitUtteranceAtSide(idx, validQs);
    }
    // single pure question extraction for declarative+question where qs contains only question
    if(qs.length===1 && isQuestion(qs[0]) && originalText.length > qs[0].length + 10){
      const q=qs[0];
      const lowerOrig=originalText.toLowerCase();
      const lowerQ=q.toLowerCase();
      let start=lowerOrig.indexOf(lowerQ);
      if(start>6){
        const prefix=originalText.slice(0,start).trim().replace(/,\s*$/,'');
        if(prefix && prefix.split(/\s+/).length>=2){
          await splitUtteranceAtSide(idx, [prefix, q]);
        }
      }
    }
  }catch(e){ console.warn('[aiDetect]',e&&e.message||e); }
}

function buildSuggestPrompt(question, contextEn) {
  function truncateForPrompt(arr, maxChars) { const j = arr.join(' | '); return j.length > maxChars ? j.slice(-maxChars) : j; }
  const sanitizedCtx = sanitizePromptContext(suggestContextPrompt);
  const contextHint = sanitizedCtx
    ? `User-provided context (use to tailor tone/style/domain of answers): """${sanitizedCtx}"""\n\n`
    : '';
  if (compressEnabled && compressedSummary) {
    const recent = contextEn.slice(-COMPRESS_RECENT_KEEP);
    const recentCtx = truncateForPrompt(recent, 1500);
    const comp = compressedSummary.length > COMPRESS_MAX_CHARS ? compressedSummary.slice(-COMPRESS_MAX_CHARS) : compressedSummary;
    return `You are a helpful assistant for a bilingual EN->VI meeting. The user just heard an English question and needs quick suggested answers in English (natural, conversational, polite).

${contextHint}Compressed history (older, summarized every 5 min): """${comp}"""

Recent conversation (latest ${recent.length} utterances): """${recentCtx}"""

Question: """${question}"""

Task: Use BOTH compressed history, recent conversation${contextHint ? ' and user-provided context' : ''} to generate context-aware answers. Return JSON with two fields:
- "structures": 3 short structure hints (3-7 words each, like "Friendly response + acknowledge shared origin + light detail")
- "answers": 3 full natural answers in English (each 3-5 sentences, 60-120 words, diverse angles: friendly / detailed / concise etc, each may contain placeholder [City, Country] if location question). Each answer must be a short paragraph of 3-5 complete sentences, natural and conversational. Answers MUST be consistent with the history${contextHint ? ' and the user-provided context' : ''}.

Output ONLY JSON object, e.g. {"structures":["Hint 1","Hint 2","Hint 3"],"answers":["Answer 1 paragraph with 3-5 sentences...","Answer 2 paragraph...","Answer 3 paragraph..."]}. No markdown, no extra text.`;
  }
  const ctx = truncateForPrompt(contextEn, 6000);
  return `You are a helpful assistant for a bilingual EN->VI meeting. The user just heard an English question and needs quick suggested answers in English (natural, conversational, polite).

${contextHint}Conversation history (all utterances, budget 6000 chars): """${ctx}"""

Question: """${question}"""

Task: Return JSON with two fields:
- "structures": 3 short structure hints (3-7 words each, like "Friendly response + acknowledge shared origin + light detail")
- "answers": 3 full natural answers in English (each 3-5 sentences, 60-120 words, diverse angles: friendly / detailed / concise etc, each may contain placeholder [City, Country] if location question). Each answer must be a short paragraph of 3-5 complete sentences, natural and conversational.${contextHint ? '\nTailor answers to the user-provided context above.' : ''}

Output ONLY JSON object, e.g. {"structures":["Hint 1","Hint 2","Hint 3"],"answers":["Answer 1 paragraph with 3-5 sentences...","Answer 2 paragraph...","Answer 3 paragraph..."]}. No markdown, no extra text.`;
}

/**
 * Retry fetch with timeout — mirror of src/services/llm/provider.js
 * (fetchWithTimeout + fetchWithRetry). Keep in sync with that file.
 * Internal AbortController enforces timeout and links an external signal.
 */
async function fetchWithRetrySidepanel(url, fetchOpts, timeoutMs = 30000, maxRetries = 2) {
  const external = fetchOpts && fetchOpts.signal;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    let abortHandler = null;
    if (external) {
      abortHandler = () => ctrl.abort();
      if (external.aborted) ctrl.abort();
      else external.addEventListener('abort', abortHandler, { once: true });
    }
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...fetchOpts, signal: ctrl.signal });
      if (res.ok) return res;
      const status = res.status;
      const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
      if (retryable && attempt < maxRetries) {
        let delay = Math.pow(2, attempt) * 500 + Math.random() * 300;
        try { const ra = res.headers.get('Retry-After'); if (ra) delay = Math.max(delay, parseInt(ra, 10) * 1000); } catch {}
        try { await res.text(); } catch {}
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError') throw e;
      if (attempt < maxRetries) { await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 400)); continue; }
      throw e;
    } finally {
      clearTimeout(t);
      if (external && abortHandler) try { external.removeEventListener('abort', abortHandler); } catch {}
    }
  }
  throw lastErr || new Error('fetch failed');
}
async function callProviderForSuggest(prompt) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) throw new Error('Empty prompt');
  const baseUrl = providerConfig.baseUrl.replace(/\/+$/, '');
  const model = providerConfig.model;
  const apiKey = providerConfig.apiKey;
  const isGemini = baseUrl.includes('generativelanguage.googleapis.com');
  if (isGemini) {
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
    const res = await fetchWithRetrySidepanel(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.8, maxOutputTokens: 1024 } })
    }, 30000, 2);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const d = await res.json(); msg = d.error?.message || msg; } catch {}
      throw new Error(msg);
    }
    const data = await res.json();
    const txt = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!txt) throw new Error('Empty LLM response');
    return txt;
  } else {
    const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetchWithRetrySidepanel(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You output ONLY JSON object with "structures" and "answers" arrays. No markdown, no extra text.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.85,
        max_tokens: 1024
      })
    }, 30000, 2);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const d = await res.json(); msg = d.error?.message || d.error || msg; } catch {}
      throw new Error(msg);
    }
    const data = await res.json();
    let txt = data.choices?.[0]?.message?.content || '';
    if (!txt && data.message?.content) txt = data.message.content;
    if (!txt) throw new Error('Empty LLM response');
    return txt;
  }
}

async function callProviderGeneric(prompt, opts = {}) {
  const baseUrl = providerConfig.baseUrl.replace(/\/+$/, '');
  const model = providerConfig.model;
  const apiKey = providerConfig.apiKey;
  const isGemini = baseUrl.includes('generativelanguage.googleapis.com');
  const temperature = opts.temperature ?? 0.4;
  const maxTokens = opts.maxTokens ?? 512;
  const systemPrompt = opts.systemPrompt || '';
  if (!prompt || typeof prompt !== 'string') throw new Error('Empty prompt');
  if (isGemini) {
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const res = await fetchWithRetrySidepanel(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }] }], generationConfig: { temperature, maxOutputTokens: maxTokens } })
    }, 25000, 2);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const d = await res.json(); msg = d.error?.message || msg; } catch {}
      throw new Error(msg);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } else {
    const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    const res = await fetchWithRetrySidepanel(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens })
    }, 25000, 2);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const d = await res.json(); msg = d.error?.message || d.error || msg; } catch {}
      throw new Error(msg);
    }
    const data = await res.json();
    let txt = data.choices?.[0]?.message?.content || '';
    if (!txt && data.message?.content) txt = data.message.content;
    return txt;
  }
}

async function performCompression(isManual = false) {
  if (compressInProgress) return;
  if (!compressEnabled && !isManual) return;
  const isLocal = providerConfig.baseUrl.includes('localhost') || providerConfig.baseUrl.includes('127.0.0.1');
  if (!providerConfig.baseUrl || !providerConfig.model || (!providerConfig.apiKey && !isLocal)) {
    if (isManual) showToast('AI Provider not configured for compression', 'error');
    return;
  }
  const pendingCount = finalizedEnPhrases.length - lastCompressedIdx;
  if (pendingCount < 2) {
    if (isManual) showToast('Not enough sentences to compress', 'default');
    return;
  }
  let segment = finalizedEnPhrases.slice(lastCompressedIdx).join('\n');
  if (segment.length > 8000) segment = segment.slice(-8000);
  if (!segment.trim() || segment.trim().length < 10) return;
  compressInProgress = true;
  showStatus('Compressing history… (agent)');
  try {
    // Compression Agent (LLM + harness tools) — QA-aware, single-shot, no loop needed
    // Mirrors src/utils/buildCompressPrompt.js + src/harness/agent/compression.agent.js
    function _isValidCompressSummary(s) {
      if (!s || typeof s !== 'string') return false;
      const t = String(s).trim();
      if (t.length < 20) return false;
      const lines = t.split('\n').map(l=>l.trim()).filter(Boolean);
      if (!lines.length) return false;
      const bullets = lines.filter(l=>/^[-•*]\s+/.test(l)).length;
      return bullets > 0;
    }
    function _buildCompressPrompt(seg, cnt, existingSummary, recentQsArr) {
      const qs = recentQsArr.join(' | ') || '(none yet)';
      const existing = existingSummary ? `\nExisting compressed history (keep continuity, don't duplicate):\n"""${sanitizePromptContext(existingSummary.slice(-2000))}"""` : '';
      const safeSeg = sanitizePromptContext(String(seg||'').slice(-8000));
      const prompt = `You are a compression agent for a live EN→VI meeting that supports answering questions.\n\nGoal: Compress the pending transcript segment into 3-5 bullet points (max 150 words, English) that PRESERVE information most useful for answering future questions. Prioritize: names, topics, decisions, questions asked, facts that could be referenced later.${existing}\n\nRecent questions in this meeting (prioritize preserving context for similar future questions):\n"""${sanitizePromptContext(qs)}"""\n\nPending segment to compress (${cnt} utterances):\n"""${safeSeg}"""\n\nOutput ONLY bullet points (each starting with "- "), no intro, no extra text.`;
      const systemPrompt = 'You are a precise meeting compression agent. Output only bullet points useful for future QA.';
      return { prompt, systemPrompt };
    }
    let summary;
    try {
      const recentQsArr = Object.values(questionSuggestions).slice(-5).map(v=>v.question);
      const { prompt: agentPrompt, systemPrompt: agentSystem } = _buildCompressPrompt(segment, pendingCount, compressedSummary, recentQsArr);
      summary = await callProviderGeneric(agentPrompt, { temperature: 0.3, maxTokens: 320, systemPrompt: agentSystem });
      if (!_isValidCompressSummary(summary)) throw new Error('Agent returned invalid summary');
    } catch (agentErr) {
      console.warn('[compress agent fallback]', agentErr.message);
      const prompt = `Summarize this conversation segment concisely. Keep key facts, names, topics, questions, decisions, and any context needed to answer future questions. Output 3-5 bullet points, max 150 words, in English. No extra intro.\n\nSegment:\n"""${sanitizePromptContext(segment)}"""`;
      summary = await callProviderGeneric(prompt, { temperature: 0.3, maxTokens: 300, systemPrompt: 'You are a concise meeting summarizer. Output only bullet points.' });
      if (!_isValidCompressSummary(summary)) throw new Error('Fallback summary invalid');
    }
    const clean = String(summary||'').trim();
    if (!clean) { if (isManual) showToast('Compression returned empty','error'); return; }
    const header = `\n[+${pendingCount} utterances @ ${new Date().toLocaleTimeString()}]`;
    compressedSummary = (compressedSummary ? compressedSummary + header + '\n' : '') + clean;
    if (compressedSummary.length > 6000) compressedSummary = compressedSummary.slice(-6000);
    lastCompressedIdx = finalizedEnPhrases.length;
    try { await storageSet({ compressedSummary, lastCompressedIdx }); } catch {}
    syncState();
    updateCompressToggleUI();
    if (isManual) showToast(`Compressed ${pendingCount} sentences`, 'success');
    else console.log('[compress] auto compressed', pendingCount, 'utterances');
  } catch (e) {
    console.warn('compress failed', e);
    if (isManual) showToast('Compression failed: ' + (e.message||e), 'error'); else showToast('Auto compress failed: '+(e.message||e),'error');
  } finally {
    compressInProgress = false; syncState();
    showStatus(isListening ? (activeAudioTrack ? 'Translating Tab audio...' : 'Listening for English (Mic)...') : 'Ready');
  }
}

function startCompressTimer() {
  stopCompressTimer();
  if (!compressEnabled) return;
  compressTimer = setInterval(() => {
    performCompression(false);
  }, COMPRESS_INTERVAL_MS);
}
function stopCompressTimer() {
  if (compressTimer) {
    clearInterval(compressTimer);
    compressTimer = null;
  }
}

function parseSuggestAnswers(raw) {
  if (!raw || typeof raw !== 'string') return { structures: [], answers: [] };
  const fenceMatch = raw.trim().match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const noFence = fenceMatch ? fenceMatch[1].trim() : raw.trim().replace(/```/g,'').trim();
  const tryParse = (s) => JSON.parse(s.replace(/,\s*([}\]])/g,'$1'));
  const isStructureLike = (s) => s.includes(' + ') && s.split(/\s+/).length < 12;
  function extractLenientArraysSide(s){
    function extractArray(key){
      const idx = s.search(new RegExp(`"${key}"\\s*:`, 'i')); if(idx===-1) return [];
      const b = s.indexOf('[', idx); if(b===-1) return [];
      let depth=0,inStr=false,esc=false,start=-1,end=-1;
      for(let i=b;i<s.length;i++){ const c=s[i]; if(inStr){ if(esc) esc=false; else if(c==='\\') esc=true; else if(c==='"') inStr=false; continue; } if(c==='"') inStr=true; else if(c==='['){ if(depth===0) start=i; depth++; } else if(c===']'){ depth--; if(depth===0){ end=i; break; } } }
      if(start===-1||end===-1) return [];
      const content=s.slice(start,end+1); const re=/"((?:\\.|[^"\\])*)"/g; let m; const arr=[];
      while((m=re.exec(content))!==null){ let v=m[1].replace(/\\"/g,'"').replace(/\\n/g,'\n').trim(); if(v) arr.push(v); if(arr.length>=5) break; }
      return arr;
    }
    return { structures: extractArray('structures'), answers: extractArray('answers') };
  }
  try {
    const objMatch = noFence.match(/\{[\s\S]*\}/);
    if (objMatch) {
      const obj = tryParse(objMatch[0]);
      if (obj && (obj.answers || obj.structures)) {
        let structures = Array.isArray(obj.structures) ? obj.structures.slice(0,5).map(s=>String(s).trim()).filter(Boolean) : [];
        let answers = Array.isArray(obj.answers) ? obj.answers.slice(0,5).map(s=>String(s).trim()).filter(Boolean) : [];
        answers = answers.filter(a => !isStructureLike(a));
        structures = structures.filter(s => s.length >= 3);
        if (answers.length || structures.length) return { structures, answers };
      }
      if (Array.isArray(obj)) {
        let arr = obj.slice(0,5).map(s=>String(s).trim()).filter(Boolean);
        arr = arr.filter(a => !isStructureLike(a));
        return { structures: [], answers: arr };
      }
    }
  } catch(_) {
    try{ const {structures:ls,answers:la}=extractLenientArraysSide(noFence); let answers=la.filter(a=>!isStructureLike(a)).filter(Boolean).slice(0,5); let structures=ls.filter(s=>s.length>=3).slice(0,5); if(answers.length||structures.length) return {structures, answers}; }catch{}
  }
  try {
    const m = noFence.match(/\[[\s\S]*\]/);
    if (m) {
      const arr = tryParse(m[0]);
      if (Array.isArray(arr)) return { structures: [], answers: arr.slice(0,5).map(s => String(s).trim()).filter(Boolean) };
    }
  } catch {}
  const lines = noFence.split(/\n/).map(s => s.replace(/^[\s\-\*\d\.\u2022]+/, '').replace(/^["']|["']$/g,'').trim()).filter(s=>s.length>=3).slice(0,5);
  if (lines.length===1 && /^\{[\s\S]*\}$/.test(lines[0]) && /"structures"|"answers"/.test(lines[0])) return { structures: [], answers: [] };
  if (lines.length>0 && lines.every(l => /^\{|\["/.test(l) && /"structures"|"answers"/.test(l))) return { structures: [], answers: [] };
  // extra guard: never return a single line that IS raw JSON (image bug)
  if (lines.length===1 && lines[0].startsWith('{"structures"')) return { structures: [], answers: [] };
  return { structures: [], answers: lines };
}

function synthesizeStructures(answers) {
  if (!Array.isArray(answers)) return [];
  return answers.map(a => {
    const words = String(a).split(/\s+/).slice(0,6).join(' ');
    return words.length > 40 ? words.slice(0,40)+'…' : words;
  });
}

async function triggerSuggestForIndex(idx, question) {
  if (!suggestEnabled) return;
  const isLocal = providerConfig.baseUrl.includes('localhost') || providerConfig.baseUrl.includes('127.0.0.1');
  if (!providerConfig.baseUrl || !providerConfig.model || (!providerConfig.apiKey && !isLocal)) {
    questionSuggestions[idx] = { state: 'error', question, answers: [], structures: [], error: 'AI Provider not configured' };
    updateSuggestCard(idx);
    updateDock();
    return;
  }
  // parallel: display loading immediately, then fetch concurrently (no serial queue)
  questionSuggestions[idx] = { state: 'loading', question, answers: [], structures: [] };
  // auto-select latest question for pills bar
  selectedQuestionIdx = idx;
  updateSuggestCard(idx);
  updateDock();
  // fire async without awaiting queue
  (async () => {
    try {
      const contextSlice = compressEnabled
        ? finalizedEnPhrases.slice(Math.max(0, idx - COMPRESS_RECENT_KEEP + 1), idx + 1)
        : finalizedEnPhrases.slice(0, idx + 1);
      const prompt = buildSuggestPrompt(question, contextSlice);
      const raw = await callProviderForSuggest(prompt);
      const parsed = parseSuggestAnswers(raw);
      let { structures, answers } = parsed;
      // safety: never keep raw JSON string as an answer (bug: fallback lines -> JSON display)
      answers = answers.filter(a => !(a.trim().startsWith('{') && /"structures"|"answers"/.test(a)));
      structures = structures.filter(s => !(s.trim().startsWith('{') && /"structures"|"answers"/.test(s)));
      // filter structure-like answers (contain " + " and short) already done in parse, but double-check
      answers = answers.filter(a => !(a.includes(' + ') && a.split(/\s+/).length < 15));
      // Validate answer quality: must be substantial (≥ 60 chars and ≥ 15 words)
      const isSubstantial = (a) => a.length >= 60 && a.split(/\s+/).length >= 15;
      const substantialAnswers = answers.filter(isSubstantial);
      if (substantialAnswers.length > 0) answers = substantialAnswers;
      else if (answers.length > 0 && answers.every(a => a.length < 60)) {
        // all answers too short — likely structures, don't show as complete answers
        answers = [];
      }
      if (answers.length === 0 && structures.length === 0) throw new Error('Failed to parse suggestions');
      if (answers.length === 0) {
        // keep answers empty — will show only structures, not fake complete answers
        // don't copy structures into answers
        console.warn('[suggest] LLM returned only structures for', question);
      }
      if (structures.length === 0 && answers.length > 0) structures = synthesizeStructures(answers);
      answers = answers.slice(0,3);
      structures = structures.slice(0,3);
      questionSuggestions[idx] = { state: 'done', question, answers, structures };
    } catch (e) {
      questionSuggestions[idx] = { state: 'error', question, answers: [], structures: [], error: e.message || 'AI error' };
    }
    updateSuggestCard(idx);
    updateDock();
    autoScroll(true);
  })();
  return;
}

// === Suggestion Dock logic (separated UI like mockup) ===
function setupSuggestionDock() {
  if (!suggestionDock) return;
  // dock tab switching
  const tabs = suggestionDock.querySelectorAll('.dock-tab[data-view]');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      suggestView = btn.dataset.view;
      tabs.forEach(b => { b.classList.toggle('active', b===btn); b.setAttribute('aria-selected', b===btn?'true':'false'); });
      renderDockBody();
    });
  });
  if (clearSuggestionsBtn) {
    clearSuggestionsBtn.addEventListener('click', () => {
      questionSuggestions = {};
      selectedQuestionIdx = null;
      updateDock();
      showToast('Suggestions cleared', 'success');
    });
  }
}

function updateDock() {
  if (!suggestionDock) return;
  const entries = Object.entries(questionSuggestions).sort((a,b)=>Number(a[0])-Number(b[0]));
  const count = entries.length;
  if (qCountBadge) qCountBadge.textContent = `${count} questions`;
  // Live switcher badge — ping when new questions arrive while user is elsewhere
  try {
    const answersBadge = document.getElementById('answersCountBadge');
    if (answersBadge) {
      if (count > 0) {
        answersBadge.hidden = false;
        answersBadge.textContent = count > 99 ? '99+' : String(count);
        if (liveView !== 'answers' && liveView !== 'split') answersBadge.classList.add('ping');
      } else {
        answersBadge.hidden = true;
        answersBadge.textContent = '';
        answersBadge.classList.remove('ping');
      }
    }
  } catch {}
  // pills
  if (questionPills) {
    questionPills.innerHTML = '';
    entries.forEach(([idx, data]) => {
      const pill = document.createElement('button');
      pill.className = 'q-pill' + (Number(idx)===selectedQuestionIdx ? ' active' : '');
      pill.dataset.idx = idx;
      const shortQ = (data.question || finalizedEnPhrases[idx] || '').slice(0,28);
      pill.textContent = `#${Number(idx)+1} ${shortQ}${shortQ.length>=28?'…':''}`;
      pill.title = data.question || finalizedEnPhrases[idx] || '';
      pill.addEventListener('click', () => {
        selectedQuestionIdx = Number(idx);
        updateDock();
        // scroll dock body to top
        if (suggestionBody) suggestionBody.scrollTop = 0;
      });
      questionPills.appendChild(pill);
    });
  }
  // auto-select latest if none
  if (selectedQuestionIdx === null && entries.length > 0) {
    selectedQuestionIdx = Number(entries[entries.length-1][0]);
  }
  if (selectedQuestionIdx !== null && !questionSuggestions[selectedQuestionIdx]) {
    selectedQuestionIdx = entries.length ? Number(entries[0][0]) : null;
  }
  renderDockBody();
  // auto-scroll pills bar to the rightmost active question
  if (questionPills) {
    requestAnimationFrame(() => {
      try {
        questionPills.scrollLeft = questionPills.scrollWidth;
        const active = questionPills.querySelector('.q-pill.active');
        if (active && active.scrollIntoView) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'end' });
      } catch {}
    });
  }
}

function renderDockBody() {
  if (!suggestionBody) return;
  if (Object.keys(questionSuggestions).length === 0) {
    suggestionBody.innerHTML = '<div class="suggest-empty" id="suggestEmpty">No questions yet. When AI detects a question, suggestions will appear here.</div>';
    return;
  }
  if (selectedQuestionIdx === null || !questionSuggestions[selectedQuestionIdx]) {
    suggestionBody.innerHTML = '<div class="suggest-empty">Select a question above to view suggestions.</div>';
    return;
  }
  const data = questionSuggestions[selectedQuestionIdx];
  if (data.state === 'loading') {
    suggestionBody.innerHTML = `<div class="suggest-loading" style="padding:12px;display:flex;gap:8px;align-items:center;color:var(--text-2);font-size:12px"><div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Generating suggestions for: <em>${escapeHtml(data.question||'')}</em></div>`;
    return;
  }
  if (data.state === 'error') {
    suggestionBody.innerHTML = `<div class="suggest-error">⚠️ ${escapeHtml(data.error)}</div>`;
    return;
  }
  // done
  const showStructure = suggestView==='both' || suggestView==='structure';
  const showComplete = suggestView==='both' || suggestView==='complete';
  let html = '';
  if (showStructure) {
    const structures = data.structures && data.structures.length ? data.structures : synthesizeStructures(data.answers);
    html += `<div class="dock-structure-list">` + structures.map((s,i)=>`
      <div class="dock-structure-item">
        <span class="idx">${i+1}.</span>
        <span class="txt">${escapeHtml(s)}</span>
        <span class="suggest-actions"><button class="suggest-copy" data-text="${escapeHtml(s).replace(/"/g,'&quot;')}" title="Copy">⎘</button></span>
      </div>
    `).join('') + `</div>`;
  }
  if (showComplete) {
    if (data.answers && data.answers.length > 0) {
      html += `<div class="dock-complete-label">Complete answers</div>`;
      html += data.answers.map(a=>`
        <div class="dock-complete-card">
          <span class="answer-text">${escapeHtml(a)}</span>
          <button class="copy-btn" data-text="${escapeHtml(a).replace(/"/g,'&quot;')}">Copy</button>
        </div>
      `).join('');
    } else if (showStructure) {
      // no complete answers, but structures shown — don't show empty label
    } else {
      html += `<div class="suggest-empty">No complete answers yet — try regenerating.</div>`;
    }
  }
  suggestionBody.innerHTML = html;
  suggestionBody.querySelectorAll('[data-text]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const txt = btn.getAttribute('data-text');
      if (txt) { await navigator.clipboard.writeText(txt); showToast('Copied','success'); }
    });
  });
}

// Split a finalized block into utterances.
// Strategy:
// 1) Split on sentence-ending punctuation (. ! ?)
// 2) Within each segment, look for the first "how" (or other strong question
//    word like "what", "why") that appears mid-sentence after a clause
//    (preceded by at least one word). That marks a new sub-utterance.
//    This keeps "How are you doing today?" intact while splitting
//    "You've been busy... how do you know Sam?" into two.
const SENT_END_RE = (() => { try { new RegExp('(?<=[.!?])'); return /(?<=[.!?])\s+(?=[A-Z0-9"']|\()|(?<=[.!?])\s*$/; } catch { return /[.!?]+\s+/; } })();
const STRONG_SPLIT_WORDS = Object.freeze(['how','what','why','where','when','who','which']);
const MIN_PREFIX_WORDS = 3;
const ABBREVS_SET = new Set(['mr','mrs','ms','dr','prof','sr','jr','st','vs','etc','inc','ltd','co']);
function normalizeForSplit(text){
  let s=String(text||'').trim();
  s=s.replace(/^[a-z]\s+(?=(?:who|what|when|where|why|how|which|whom|whose|whether|okay|ok|yeah|yep|right|how's|what's|where's)\b)/i,'');
  if(/^[b-hj-zB-HJ-Z]\s+\w/.test(s) && s.split(/\s+/).length>=2){
    const parts=s.split(/\s+/);
    if(parts[0].length===1 && parts[1].length>=2) s=s.replace(/^[a-z]\s+/i,'');
  }
  s=s.replace(/\b(you)estion\b/gi,'$1');
  s=s.replace(/\b(how)estion\b/gi,'$1');
  s=s.replace(/\b(what)estion\b/gi,'$1');
  s=s.replace(/\s+([?!.])/g,'$1');
  return s;
}
const RE_DECLARATIVE_START_SIDE = /^(i'm|i am|i was|my name|i was born|today|now|then|here|my|our|your|i've|we're|they're|i)\b/i;
const RE_WH_SUBORDINATE_SIDE = /^(who|what|when|where|why|how|which|whom|whose|whether)\s+(someone|somebody|something|somewhere|anyone|anybody|anything|everyone|everybody|people|they|he|she|it|we|you|one)\s+(is|are|was|were|will|would|can|could|should|have|has|had|be|been)\b/i;
const RE_IMPERATIVE_DO_SIDE = /^(do|does|did)\s+(this|that|these|those|it)\b/i;
function isQuestionForSplitSide(s){
  const t=String(s||'').trim(); if(!t) return false; if(t.includes('?')) return true;
  const lower=t.toLowerCase(); const words=lower.split(/\s+/).filter(Boolean); if(words.length<3) return false;
  if(/\b(to|for|with|of|in|on|at|a|an|the)\s*$/i.test(t)) return false;
  if(RE_WH_SUBORDINATE_SIDE.test(t)) return false;
  if(RE_IMPERATIVE_DO_SIDE.test(t) && !/\b(you|we|they|he|she)\b/i.test(t.split(/\s+/).slice(0,4).join(' '))) return false;
  if(/^(who|what|when|where|why|how|which|whom|whose|whether|what's|how's|where's|when's|who's|why's)\b/i.test(t) && !RE_WH_SUBORDINATE_SIDE.test(t)) return true;
  if(/^(is|are|was|were|am|be|been|being|do|does|did|can|could|will|would|shall|should|may|might|must|have|has|had|ought|need|dare|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|cannot|won't|wouldn't|shouldn't|hasn't|haven't|hadn't)\s+(you|he|she|they|we|i|it|there|one|anyone|anybody|everyone|someone|somebody|this|that|these|those)\b/i.test(t)){
    const aux=t.split(/\s+/)[0].toLowerCase(); const isDo=/^(do|does|did)\b/i.test(aux);
    if(isDo && /^(do|does|did)\s+(this|that|these|those|it)\b/i.test(t) && !/\b(you|we|they|he|she|i)\b/i.test(t.toLowerCase())) return false;
    return true;
  }
  if(/\b(do you|does he|does she|do they|did you|are you|is he|is she|are they|is there|are there|can you|could you|would you|will you|have you|has anyone|do you have|are you going|have you ever|would you like)\b/i.test(lower) && words.length>=4) return true;
  return false;
}
function isNoiseUtteranceSide(s){
  const t=s.trim();
  if(!t) return true;
  if(t.length<=1) return true;
  if(/^[a-z]$/i.test(t)) return true;
  if(/^[a-z]\s*$/i.test(t)) return true;
  const parts=t.split(/\s+/);
  if(parts.length===1 && t.length<=2) return true;
  if(parts.length>=1 && parts.every((w)=>w.length===1)) return true;
  if(parts.length<=3 && parts.join('').length<=3 && !/[aeiou]/i.test(t)) return true;
  return false;
}
function findQuestionDeclarativeSplitSide(seg){
  const words=seg.split(/\s+/);
  if(words.length<4) return -1;
  const segWords=seg.split(/\s+/);
  const charPos=[0]; let p=0;
  for(let wi=0;wi<segWords.length;wi++){ p+=segWords[wi].length+1; charPos.push(p); }
  for(let i=3;i<=words.length-2;i++){
    const left=words.slice(0,i).join(' ');
    const right=words.slice(i).join(' ');
    if(left.split(/\s+/).length<3 || right.split(/\s+/).length<2) continue;
    if(!RE_Q_START_SIDE.test(left) || !isQuestionForSplitSide(left)) continue;
    if(!RE_DECLARATIVE_START_SIDE.test(right)) continue;
    return charPos[i];
  }
  return -1;
}
function findDeclarativeQuestionSplitSide(seg){
  const words=seg.split(/\s+/);
  if(words.length<6) return -1;
  const segWords=seg.split(/\s+/);
  const charPos=[0]; let p=0;
  for(let wi=0;wi<segWords.length;wi++){ p+=segWords[wi].length+1; charPos.push(p); }
  for(let i=3;i<=words.length-3;i++){
    const left=words.slice(0,i).join(' ');
    const right=words.slice(i).join(' ');
    if(left.split(/\s+/).length<3 || right.split(/\s+/).length<3) continue;
    if(isQuestionForSplitSide(left)) continue;
    if(!isQuestionForSplitSide(right)) continue;
    if(!RE_Q_START_SIDE.test(right)) continue;
    return charPos[i];
  }
  return -1;
}

/**
 * Pure: split block into utterances — no side effects, validated, Safari fallback, abbrev-aware.
 * @param {unknown} text
 * @returns {string[]}
 */
function splitIntoUtterances(text) {
  const trimmed = normalizeForSplit(String(text||'').trim());
  if (!trimmed) return [];
  const segs = trimmed.split(SENT_END_RE).map(s => s.trim()).filter(Boolean);
  const merged = [];
  for (let i=0;i<segs.length;i++) {
    const cur = segs[i];
    if (merged.length>0) {
      const prev = merged[merged.length-1];
      const lastWord = prev.split(/\s+/).pop()?.replace(/\.+$/,'').toLowerCase()||'';
      if (ABBREVS_SET.has(lastWord)) { merged[merged.length-1]=prev+' '+cur; continue; }
    }
    merged.push(cur);
  }
  const out = [];
  for (const seg of merged) {
    const queue=[seg];
    const segOut=[];
    while(queue.length){
      const cur=queue.shift();
      const qdIdx=findQuestionDeclarativeSplitSide(cur);
      if(qdIdx>0){
        let left=cur.slice(0,qdIdx).trim().replace(/,\s*$/,'');
        const right=cur.slice(qdIdx).trim().replace(/^,\s*/,'');
        if(left && right && right.split(/\s+/).length>=2 && left.split(/\s+/).length>=2){ queue.unshift(right); segOut.push(left); continue; }
      }
      const dqIdx=findDeclarativeQuestionSplitSide(cur);
      if(dqIdx>0){
        let left=cur.slice(0,dqIdx).trim().replace(/,\s*$/,'');
        const right=cur.slice(dqIdx).trim().replace(/^,\s*/,'');
        if(left && right && right.split(/\s+/).length>=3 && left.split(/\s+/).length>=2){ queue.unshift(right); segOut.push(left); continue; }
      }
      const lower=cur.toLowerCase();
      let splitPos=-1;
      const wordsAll=cur.split(/\s+/);
      if(wordsAll.length>=6){
        const wPos=[0]; let pp=0; for(let wi=0;wi<wordsAll.length;wi++){ pp+=wordsAll[wi].length+1; wPos.push(pp); }
        for(let i=MIN_PREFIX_WORDS;i<=wordsAll.length-3;i++){
          const right=wordsAll.slice(i).join(' '); const left=wordsAll.slice(0,i).join(' ');
          if(left.split(/\s+/).length<MIN_PREFIX_WORDS) continue;
          if(!isQuestionForSplitSide(right)) continue;
          if(!RE_Q_START_SIDE.test(right)) continue;
          splitPos=wPos[i]; break;
        }
      }
      if(splitPos===-1){
        for(const word of STRONG_SPLIT_WORDS){
          const re=new RegExp(`\\b${word}\\b`,'i');
          const m=re.exec(cur);
          if(m && m.index>0){
            const prefix=cur.slice(0,m.index).trim();
            const suffix=cur.slice(m.index).trim();
            const cnt=prefix?prefix.split(/\s+/).length:0;
            if(cnt>=MIN_PREFIX_WORDS && isQuestionForSplitSide(suffix) && (splitPos===-1 || m.index<splitPos)) splitPos=m.index;
          }
        }
      }
      if(splitPos===-1){
        for(const w of ['hows','whats','wheres','whos']){
          const idx=lower.indexOf(w+' ');
          if(idx>0){
            const prefix=cur.slice(0,idx).trim(); const suffix=cur.slice(idx).trim();
            if(prefix.split(/\s+/).length>=MIN_PREFIX_WORDS && isQuestionForSplitSide(suffix)){ splitPos=idx; break; }
          }
        }
      }
      if(splitPos===-1 && cur.includes(',')){
        const cIdx=cur.indexOf(',');
        const left=cur.slice(0,cIdx).trim();
        const right=cur.slice(cIdx+1).trim();
        const lw=left?left.split(/\s+/).length:0;
        const rw=right?right.split(/\s+/).length:0;
        if(lw>=2 && lw<=12 && rw>=2){
          const leftIsQ=RE_Q_START_SIDE.test(left) || /\b(how are you|what do you|where are you)\b/i.test(left);
          if(leftIsQ && /^[A-Z]/i.test(right)){ queue.unshift(right); segOut.push(left); continue; }
        }
      }
      if(splitPos>0){
        const left=cur.slice(0,splitPos).trim();
        const right=cur.slice(splitPos).trim();
        if(left && right && right.split(/\s+/).length>=2){ queue.unshift(right); segOut.push(left); }
        else segOut.push(cur);
      } else segOut.push(cur);
    }
    for(const s of segOut){ if(!isNoiseUtteranceSide(s)) out.push(s); }
  }
  return out.filter(Boolean);
}

/**
 * Finalize block — splits, validates, creates DOM via DocumentFragment, translates concurrently.
 * @param {unknown} text
 * @returns {Promise<void>}
 */
async function finalizeText(text) {
  let cleanText = text.trim();
  if (!cleanText) return;
  // Merge fragmented across consecutive finals: e.g. "how to push yourself to" + "o success yeah"
  // If previous utterance is incomplete (ends with to/for/with) and current is tag continuation
  if (finalizedEnPhrases.length > 0 && !text.includes('.') && !text.includes('!') && !text.includes('?')) {
    const prevIdx = finalizedEnPhrases.length - 1;
    const prevText = finalizedEnPhrases[prevIdx];
    const prevCache = utteranceDomCache[prevIdx];
    const isPrevPendingLive = prevCache && prevCache.isLive;
    if (!isPrevPendingLive && prevText) {
      const prevIncomplete = /\b(to|for|with|of|in|on|at|a|an|the)\s*$/i.test(prevText.trim());
      const curNorm = normalizeForSplit(cleanText);
      const combined = (prevText + ' ' + curNorm).trim();
      const curIsTagFrag = /\b(success|right|yeah|okay|ok|yep|huh)\s*\??\s*$/i.test(curNorm) || curNorm.split(/\s+/).length <= 3;
      // also check if prev is WH-started and cur is short continuation
      const prevIsWH = RE_WH_START.test(prevText) || RE_Q_START_SIDE.test(prevText);
      if ((prevIncomplete || (prevIsWH && curIsTagFrag)) && isQuestion(combined) && combined.split(/\s+/).length <= 14) {
        // remove previous utterance (pop)
        const removedEn = finalizedEnPhrases.pop();
        const removedVi = finalizedViPhrases.pop();
        utteranceSpeakers.pop();
        const removedCache = utteranceDomCache.pop();
        if (removedCache && removedCache.root && removedCache.root.parentNode) {
          try { removedCache.root.remove(); } catch {}
        }
        // adjust selectedQuestionIdx and suggestions map (shift indices)
        // Note: compactTranscriptMemory already handled indices, now we manually shift
        // For simplicity, if previous was a question, remove its suggestion
        if (questionSuggestions[prevIdx]) {
          delete questionSuggestions[prevIdx];
          if (selectedQuestionIdx === prevIdx) selectedQuestionIdx = null;
          // shift down any higher indices
          const newQs = {};
          for (const k of Object.keys(questionSuggestions)) {
            const ki = Number(k);
            if (ki > prevIdx) newQs[ki - 1] = questionSuggestions[k];
            else newQs[ki] = questionSuggestions[k];
          }
          questionSuggestions = newQs;
          if (selectedQuestionIdx !== null && selectedQuestionIdx > prevIdx) selectedQuestionIdx--;
        }
        // update caches indices for remaining
        utteranceDomCache.forEach((c, i) => { if (c && c.root) c.root.dataset.index = i; });
        cleanText = combined;
        // continue to split normally (will be one utterance)
      }
    }
  }

  // Memory guard: drop the oldest utterances (beyond 2x DOM cap) and re-index
  // everything before computing any indices below. Mirror of
  // src/services/transcript/compact.js compactTranscriptState().
  compactTranscriptMemory();

  // If a live utterance is pending, promote it with this text instead of appending a new one
  const liveCache = utteranceDomCache[utteranceDomCache.length - 1];
  if (liveCache && liveCache.isLive) {
    const liveSpeaker = liveCache._speakerId !== undefined ? liveCache._speakerId : currentSpeakerId;
    promoteLiveToFinal(cleanText);
    const idx = utteranceDomCache.length - 1;
    utteranceSpeakers[idx] = liveSpeaker;
    // ensure DOM reflects speaker (badge/color)
    if (liveCache) applySpeakerToDom(liveCache, liveSpeaker);
    updateWordCounts();
    showStatus('Translating...');
    const translated = await translateText(cleanText);
    finalizedViPhrases[idx] = translated || '[Translation failed]';
    if (liveCache) {
      setViText(liveCache.viText, finalizedViPhrases[idx]);
      liveCache.copyVi.dataset.text = finalizedViPhrases[idx];
      liveCache.copyVi.disabled = false;
      if (liveCache.colVi && finalizedViPhrases[idx] !== '[Translation failed]') {
        liveCache.colVi.classList.add('vi-just-arrived');
        setTimeout(() => liveCache.colVi.classList.remove('vi-just-arrived'), 800);
      }
    }
    updateWordCounts();
    if (activeAudioTrack) {
      showStatus('Translating Tab audio...');
    } else {
      showStatus('Listening for English (Mic)...');
    }
    // Promoting live -> layout changes; force sticky scroll to the new final utterance (newest on top)
    shouldStickToTop = true;
    autoScroll(true);

    // After translation, detect question and trigger AI suggest (non-blocking)
    if (isQuestion(cleanText)) {
      triggerSuggestForIndex(idx, cleanText);
    }
    // AI supplement: non-blocking verify for multi-question / false-negative (only when suspicious)
    handleAiVerifyForIndexSide(idx, cleanText).catch(()=>{});
    updateCompressToggleUI();
    return;
  }

  // Split the incoming block into separate utterances for cleaner display
  const utterances = splitIntoUtterances(cleanText);
  const firstIdx = finalizedEnPhrases.length;

  hidePlaceholders();
  // Assign speaker to each new sub-utterance (heuristic: alternate if long pause already toggled,
  // otherwise keep currentSpeakerId; if multiple sub-utterances from same block, alternate them)
  const baseSpeaker = currentSpeakerId;
  // Push all utterances to EN
  utterances.forEach((u, k) => {
    finalizedEnPhrases.push(u);
    // if split produced multiple utterances from one final block, treat them as possibly different speakers
    // but only alternate when we already detected a speaker switch recently; otherwise keep same
    utteranceSpeakers.push(baseSpeaker);
  });
  // Push placeholder to VI
  utterances.forEach(() => finalizedViPhrases.push('…'));
  // Capture stickiness before appending new nodes (newest on top, so stick to top)
  if (isNearTop()) shouldStickToTop = true;
  // Prepend each new utterance to the feed (newest on top, DOM order = visual order)
  for (let i = 0; i < utterances.length; i++) {
    const idx = firstIdx + i;
    if (!utteranceDomCache[idx]) {
      appendUtterance(idx);
    }
  }
  updateWordCounts();

  // Translate each utterance concurrently (pool = 3) - optimized
  showStatus('Translating...');
  const tasks = [];
  for (let k = 0; k < utterances.length; k++) {
    const idx = firstIdx + k;
    const cache = utteranceDomCache[idx];
    if (finalizedViPhrases[idx] && finalizedViPhrases[idx] !== '…') {
      if (cache) {
        setViText(cache.viText, finalizedViPhrases[idx]);
        cache.copyVi.dataset.text = finalizedViPhrases[idx];
        cache.copyVi.disabled = false;
      }
      continue;
    }
    tasks.push({ idx, text: utterances[k], cache });
  }
  if (tasks.length > 0) {
    await translateBatchConcurrent(tasks, MAX_CONCURRENT_TRANSLATE);
  }
  pruneOldUtterances();

  if (activeAudioTrack) {
    showStatus('Translating Tab audio...');
  } else {
    showStatus('Listening for English (Mic)...');
  }

  // Clear interim display
  if (englishInterim) englishInterim.innerText = '';
  if (vietnameseInterim) vietnameseInterim.innerText = '';
  if (interimBlock) interimBlock.style.display = 'none';
  shouldStickToTop = true;
  autoScroll(true);

  // After translation, detect question and trigger AI suggest (non-blocking)
  utterances.forEach((u, k) => {
    if (isQuestion(u)) {
      triggerSuggestForIndex(firstIdx + k, u);
    }
  });
  // AI supplement: verify each utterance only when suspicious (cost-controlled, async)
  utterances.forEach((u, k) => {
    const idx = firstIdx + k;
    handleAiVerifyForIndexSide(idx, u).catch(()=>{});
  });
  updateCompressToggleUI(); try { updateContextInspector(); } catch {}
}

/** @param {string} text @param {number} rawLength @returns {Promise<void>} */
async function forceFinalizeText(text, rawLength) {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  
  // Set offset pointer to prevent double-processing
  finalizedOffset = rawLength;
  
  // Clear interim displays immediately
  if (englishInterim) englishInterim.innerText = '';
  if (vietnameseInterim) vietnameseInterim.innerText = '';
  if (interimBlock) interimBlock.style.display = 'none';
  
  await finalizeText(text);
}

// Live utterance helpers: the first feed item (top) acts as the "live" block while speech
// is in progress. It is finalized in place (no re-ordering, no layout jump). Newest on top.
function ensureLiveUtterance() {
  const lastCache = utteranceDomCache[utteranceDomCache.length - 1];
  if (lastCache && lastCache.isLive) return lastCache;
  // Capture stickiness before DOM grows (newest on top)
  const wasNear = isNearTop();
  if (wasNear) shouldStickToTop = true;
  // Create a fresh live slot with current speaker
  const idx = finalizedEnPhrases.length;
  finalizedEnPhrases.push('');
  finalizedViPhrases.push('…');
  utteranceSpeakers.push(currentSpeakerId);
  const cache = buildUtteranceDom(idx, '', '…');
  cache.isLive = true;
  cache._speakerId = currentSpeakerId;
  cache.root.classList.add('is-live');
  applySpeakerToDom(cache, currentSpeakerId);
  utteranceDomCache[idx] = cache;
  return cache;
}

function promoteLiveToFinal(enText) {
  const lastCache = utteranceDomCache[utteranceDomCache.length - 1];
  if (lastCache && lastCache.isLive) {
    lastCache.isLive = false;
    lastCache.root.classList.remove('is-live');
    lastCache.root.classList.add('was-live');
    const en = enText || finalizedEnPhrases[utteranceDomCache.length - 1] || '';
    finalizedEnPhrases[utteranceDomCache.length - 1] = en;
    if (lastCache.enText) {
      lastCache.enText.textContent = en;
      lastCache.enText.classList.remove('typing');
    }
    if (lastCache.copyEn) lastCache.copyEn.dataset.text = en;
    const isQ = isQuestion(en);
    lastCache.root.classList.toggle('question', isQ);
    if (isQ && lastCache.enText && !lastCache.enText.querySelector('.question-mark')) {
      const qSpan = document.createElement('span');
      qSpan.className = 'question-mark';
      qSpan.textContent = '?';
      lastCache.enText.appendChild(document.createTextNode(' '));
      lastCache.enText.appendChild(qSpan);
    }
    return true;
  }
  return false;
}

// Translate Text via Google Translate free API — cache + chunking + retry + LRU
async function translateText(text, opts = {}) {
  if (!text || !String(text).trim()) return '';
  const trimmed = String(text).trim();
  if (translationCache.has(trimmed)) {
    const cached = translationCache.get(trimmed);
    translationCache.delete(trimmed); translationCache.set(trimmed, cached);
    return cached;
  }
  const TRANSLATE_MAX = 4200;
  if (trimmed.length > TRANSLATE_MAX) {
    const parts = (() => {
      const segs = trimmed.split(/(?<=[.!?])\s+/);
      const chunks=[]; let cur='';
      for (const p of segs) {
        if ((cur+' '+p).trim().length > TRANSLATE_MAX) {
          if (cur) chunks.push(cur.trim());
          if (p.length > TRANSLATE_MAX) { for (let i=0;i<p.length;i+=TRANSLATE_MAX) chunks.push(p.slice(i,i+TRANSLATE_MAX)); cur=''; }
          else cur=p;
        } else cur = cur ? cur+' '+p : p;
      }
      if (cur) chunks.push(cur.trim());
      return chunks;
    })();
    if (parts.length>1) {
      const outs=[];
      for (const c of parts) { if (opts.signal?.aborted) return ''; const r=await translateText(c, opts); outs.push(r||c); }
      const joined=outs.join(' ');
      if (joined) { translationCache.set(trimmed, joined); if (translationCache.size>TRANSLATION_CACHE_MAX) translationCache.delete(translationCache.keys().next().value); }
      return joined;
    }
  }
  const retries = opts.retries ?? 2;
  let lastErr=null;
  for (let attempt=0; attempt<=retries; attempt++) {
    const controller=new AbortController();
    const hasExternalSignal=!!opts.signal;
    const signal=hasExternalSignal? opts.signal : controller.signal;
    if (!hasExternalSignal) activeTranslateControllers.add(controller);
    const timeoutId=setTimeout(()=>{ try{controller.abort();}catch{} }, CONFIG.TRANSLATE_TIMEOUT_MS);
    let externalAbortHandler=null;
    if (hasExternalSignal && opts.signal!==controller.signal) {
      externalAbortHandler=()=>controller.abort();
      opts.signal.addEventListener('abort', externalAbortHandler, {once:true});
    }
    try {
      const url=`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=${encodeURIComponent(trimmed)}`;
      const response=await fetch(url, { signal: hasExternalSignal? opts.signal : controller.signal });
      if (!response.ok) {
        const status=response.status;
        if ((status===429 || status>=500) && attempt<retries) {
          let delay=Math.pow(2,attempt)*400+Math.random()*200;
          try{ const ra=response.headers.get('Retry-After'); if(ra) delay=Math.max(delay, parseInt(ra,10)*1000);}catch{}
          try{ await response.text(); }catch{}
          await new Promise(r=>setTimeout(r, delay));
          continue;
        }
        throw new Error(`HTTP ${status}`);
      }
      const data=await response.json();
      let translation='';
      if (data && data[0]) for (let i=0;i<data[0].length;i++) if (data[0][i]&&data[0][i][0]) translation+=data[0][i][0];
      translation=String(translation||'').trim();
      if (!translation && attempt<retries && trimmed.length>3) { await new Promise(r=>setTimeout(r, 300*(attempt+1))); continue; }
      if (translation) {
        translationCache.set(trimmed, translation);
        if (translationCache.size>TRANSLATION_CACHE_MAX) translationCache.delete(translationCache.keys().next().value);
      }
      return translation;
    } catch (error) {
      lastErr=error;
      if (error.name==='AbortError') return '';
      const retryable=error.message && (error.message.includes('Failed to fetch')||error.message.includes('NetworkError'));
      if (retryable && attempt<retries) { await new Promise(r=>setTimeout(r, Math.pow(2,attempt)*350)).catch(()=>{}); continue; }
      if (attempt>=retries) { console.error('Translation error:', error); return ''; }
      await new Promise(r=>setTimeout(r, Math.pow(2,attempt)*300)).catch(()=>{});
    } finally {
      clearTimeout(timeoutId);
      if (externalAbortHandler) try{ opts.signal.removeEventListener('abort', externalAbortHandler);}catch{}
      activeTranslateControllers.delete(controller);
    }
  }
  if (lastErr) console.error('[translateText] exhausted', lastErr);
  return '';
}

/** Abort all pending translate fetches — idempotent */
function abortAllPendingTranslations() {
  for (const c of activeTranslateControllers) { try { c.abort(); } catch {} }
  activeTranslateControllers.clear();
}

/**
 * Translate batch with concurrency limit — validated, preserves order, handles abort.
 * @param {{idx:number,text:string,cache:any}[]} tasks
 * @param {number} concurrency
 * @returns {Promise<string[]>}
 */
async function translateBatchConcurrent(tasks, concurrency = CONFIG.MAX_CONCURRENT_TRANSLATE) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const conc = Math.max(1, Math.min(concurrency, tasks.length, 5));
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const cur = next++; if (cur >= tasks.length) break;
      const t = tasks[cur];
      if (!t || typeof t.text !== 'string' || !t.text.trim()) { results[cur] = ''; continue; }
      if (finalizedViPhrases[t.idx] && finalizedViPhrases[t.idx] !== '…' && finalizedViPhrases[t.idx] !== '[Translation failed]') { results[cur] = finalizedViPhrases[t.idx]; continue; }
      try {
        const out = await translateText(t.text);
        const val = out || '[Translation failed]';
        results[cur] = val; finalizedViPhrases[t.idx] = val;
        if (t.cache) {
          setViText(t.cache.viText, val); if (t.cache.copyVi) { t.cache.copyVi.dataset.text = val; t.cache.copyVi.disabled = val==='[Translation failed]'; }
          if (t.cache.colVi && val !== '[Translation failed]') { t.cache.colVi.classList.add('vi-just-arrived'); setTimeout(() => t.cache.colVi.classList.remove('vi-just-arrived'), 800); }
        }
        scheduleWordCountUpdate();
      } catch (e) {
        if (e.name==='AbortError') { results[cur]=''; break; }
        results[cur]='[Translation failed]';
      }
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  return results;
}

// Live VI preview — debounced + abortable, skips short interim
let liveViDebounce = null; let liveViController = null;
/**
 * @param {string} text
 */
function debouncedTranslateInterim(text) {
  if (liveViDebounce) { clearTimeout(liveViDebounce); liveViDebounce = null; }
  if (liveViController) { try { liveViController.abort(); } catch {} liveViController = null; }
  if (!text || String(text).trim().length < 8) return;
  liveViDebounce = setTimeout(async () => {
    const trimmed = String(text).trim(); if (!trimmed) return;
    const liveCache = utteranceDomCache[utteranceDomCache.length - 1];
    if (!liveCache || !liveCache.isLive) return;
    const snapshot = trimmed;
    liveViController = new AbortController();
    const translated = await translateText(snapshot, { signal: liveViController.signal });
    liveViController = null;
    const stillLive = utteranceDomCache[utteranceDomCache.length - 1];
    if (stillLive && stillLive.isLive && liveCache.enText && liveCache.enText.textContent === snapshot && translated) setViText(liveCache.viText, translated);
  }, CONFIG.INTERIM_DEBOUNCE_MS);
}

// Render finalized logs (legacy hidden) + combined single block
function renderEnglish() {
  if (englishLog) englishLog.innerHTML = finalizedEnPhrases.map(p => `<p>${escapeHtml(p)}</p>`).join('');
  renderCombined();
}
function renderVietnamese() {
  if (vietnameseLog) vietnameseLog.innerHTML = finalizedViPhrases.map(p => `<p>${escapeHtml(p)}</p>`).join('');
  renderCombined();
}

function renderCombined() {
  if (!transcriptFeed) return;
  if (finalizedEnPhrases.length > 0 && combinedPlaceholder) combinedPlaceholder.style.display = 'none';

  // Flush pending updates that were batched since last render
  pendingRenderQueue.forEach(idx => updateUtteranceInPlace(idx));
  pendingRenderQueue.clear();

  // Append new utterances (indices not yet in DOM cache)
  for (let i = 0; i < finalizedEnPhrases.length; i++) {
    if (!utteranceDomCache[i]) {
      appendUtterance(i);
    } else if (!(utteranceDomCache[i].isLive)) {
      updateUtteranceInPlace(i);
    }
  }
}

function applySpeakerToDom(cache, speakerId) {
  if (!cache || !cache.root) return;
  cache._speakerId = speakerId;
  cache.root.setAttribute('data-speaker', String(speakerId));
  cache.root.classList.remove('speaker-0', 'speaker-1');
  cache.root.classList.add(`speaker-${speakerId % 2}`);
  // remove any legacy badge if it exists (no longer displayed)
  if (cache.speakerBadge && cache.speakerBadge.parentNode) {
    cache.speakerBadge.remove();
    cache.speakerBadge = null;
  }
  const legacy = cache.root.querySelector('.speaker-badge');
  if (legacy) legacy.remove();
}

// Build the DOM for an utterance (shared by appendUtterance and live slot)
function buildUtteranceDom(idx, en, vi) {
  const isQ = isQuestion(en);
  const qMark = isQ ? ' <span class="question-mark">?</span>' : '';

  // Build the utterance DOM node
  const root = document.createElement('div');
  root.className = 'utterance' + (isQ ? ' question' : '');
  root.dataset.index = idx;

  const body = document.createElement('div');
  body.className = 'utterance-body';

  // EN column
  const colEn = document.createElement('div');
  colEn.className = 'utterance-col utterance-col-en';
  const enLabel = document.createElement('span');
  enLabel.className = 'utterance-lang';
  enLabel.textContent = 'EN';
  const enText = document.createElement('span');
  enText.className = 'utterance-en-text';
  enText.textContent = en;
  if (isQ) {
    const qSpan = document.createElement('span');
    qSpan.className = 'question-mark';
    qSpan.textContent = '?';
    enText.appendChild(document.createTextNode(' '));
    enText.appendChild(qSpan);
  }
  colEn.appendChild(enLabel);
  colEn.appendChild(enText);

  // VI column
  const colVi = document.createElement('div');
  colVi.className = 'utterance-col utterance-col-vi';
  const viLabel = document.createElement('span');
  viLabel.className = 'utterance-lang';
  viLabel.textContent = 'VI';
  const viText = document.createElement('span');
  viText.className = 'utterance-vi-text';
  setViText(viText, vi);
  colVi.appendChild(viLabel);
  colVi.appendChild(viText);

  body.appendChild(colEn);
  body.appendChild(colVi);
  root.appendChild(body);

  // Copy row
  const copyRow = document.createElement('div');
  copyRow.className = 'utterance-copy-row';
  const copyEn = document.createElement('button');
  copyEn.className = 'copy-mini-btn copy-en';
  copyEn.dataset.text = en;
  copyEn.title = 'Copy EN';
  copyEn.innerHTML = '<span class="lang-tag">EN</span> ⎘';
  const copyVi = document.createElement('button');
  copyVi.className = 'copy-mini-btn copy-vi';
  copyVi.dataset.text = (vi !== '…') ? vi : '';
  copyVi.title = 'Copy VI';
  copyVi.innerHTML = '<span class="lang-tag">VI</span> ⎘';
  copyRow.appendChild(copyEn);
  copyRow.appendChild(copyVi);
  root.appendChild(copyRow);

  // Suggest card container
  const suggestCard = document.createElement('div');
  suggestCard.className = 'suggest-card-wrap';
  root.appendChild(suggestCard);

  // Copy delegation (local, not whole feed)
  const handleCopy = async (btn) => {
    const txt = btn.dataset.text;
    if (txt && txt !== '…') {
      await navigator.clipboard.writeText(txt);
      showToast('Copied', 'success');
    }
  };
  copyEn.addEventListener('click', () => handleCopy(copyEn));
  copyVi.addEventListener('click', () => handleCopy(copyVi));

  // Insert into feed — newest on top (prepend). Previously appended to bottom.
  if (transcriptFeed.firstChild) {
    transcriptFeed.insertBefore(root, transcriptFeed.firstChild);
  } else {
    transcriptFeed.appendChild(root);
  }

  return {
    root, body, colEn, colVi, enText, viText, copyEn, copyVi, suggestCard,
    isLive: false
  };
}

// Add a single utterance to the feed (newest on top -> prepend)
function appendUtterance(idx) {
  const en = finalizedEnPhrases[idx] || '';
  const vi = finalizedViPhrases[idx] !== undefined ? finalizedViPhrases[idx] : '…';
  const spk = utteranceSpeakers[idx] !== undefined ? utteranceSpeakers[idx] : currentSpeakerId;

  const cache = buildUtteranceDom(idx, en, vi);
  cache._speakerId = spk;
  applySpeakerToDom(cache, spk);
  utteranceSpeakers[idx] = spk;
  utteranceDomCache[idx] = cache;

  // Auto scroll - instant for append to avoid jank, smooth only on finalize
  autoScroll(false, 'instant');
  pruneOldUtterances();

  // If there's a suggestion state, render it
  updateSuggestCard(idx);
}

/**
 * Memory guard — drop oldest utterances once transcript exceeds 2x DOM cap,
 * then re-index arrays, DOM cache, suggestion map, selected idx, compress pointer.
 * Mirror of src/services/transcript/compact.js compactTranscriptState().
 * @returns {number} shift count (0 = nothing dropped)
 */
function compactTranscriptMemory() {
  const len = finalizedEnPhrases.length;
  if (len <= MAX_DOM_UTTERANCES * 2) return 0;
  const n = len - MAX_DOM_UTTERANCES;
  if (n <= 0) return 0;
  finalizedEnPhrases.splice(0, n);
  finalizedViPhrases.splice(0, n);
  utteranceSpeakers.splice(0, n);
  // Re-map DOM cache (holes stay holes) + refresh dataset.index
  const newCache = new Array(finalizedEnPhrases.length);
  utteranceDomCache.forEach((c, oldIdx) => {
    if (!c) return;
    const newIdx = oldIdx - n;
    if (newIdx < 0) { try { if (c.root && c.root.parentNode && !c.isLive) c.root.remove(); } catch {} return; }
    newCache[newIdx] = c;
    if (c.root) c.root.dataset.index = newIdx;
    if (typeof c.idx === 'number') c.idx = newIdx;
  });
  utteranceDomCache.length = 0;
  utteranceDomCache.push(...newCache);
  // Re-map question suggestions
  const nextQ = {};
  for (const k of Object.keys(questionSuggestions)) {
    const ki = Number(k);
    if (Number.isFinite(ki) && ki >= n) nextQ[ki - n] = questionSuggestions[k];
  }
  questionSuggestions = nextQ;
  // Re-map selected idx
  if (selectedQuestionIdx !== null && selectedQuestionIdx !== undefined) {
    const a = Number(selectedQuestionIdx) - n;
    const keys = Object.keys(questionSuggestions).map(Number).sort((x, y) => x - y);
    selectedQuestionIdx = (a >= 0 && questionSuggestions[a]) ? a : (keys.length ? keys[keys.length - 1] : null);
  } else if (selectedQuestionIdx === null && Object.keys(questionSuggestions).length) {
    const keys = Object.keys(questionSuggestions).map(Number).sort((x, y) => x - y);
    selectedQuestionIdx = keys[keys.length - 1];
  }
  // Re-map compress pointer (older segment already folded into compressedSummary)
  lastCompressedIdx = Math.max(0, (lastCompressedIdx || 0) - n);
  syncState();
  return n;
}

function pruneOldUtterances() {
  // virtualization: keep DOM light when transcript grows large
  if (finalizedEnPhrases.length <= MAX_DOM_UTTERANCES) return;
  const toRemove = finalizedEnPhrases.length - MAX_DOM_UTTERANCES;
  for (let i = 0; i < toRemove; i++) {
    const cache = utteranceDomCache[i];
    if (cache && cache.root && cache.root.parentNode && !cache.isLive) {
      cache.root.remove();
      // keep array slot but mark as pruned for later re-render if needed
      utteranceDomCache[i] = null;
    }
  }
}

// Update a single utterance in place (translation arrived or suggest updated)
function updateUtteranceInPlace(idx) {
  const cache = utteranceDomCache[idx];
  if (!cache) return;
  const vi = finalizedViPhrases[idx];
  // Update VI text
  setViText(cache.viText, vi);
  // Update copy-vi button
  if (vi && vi !== '…') {
    cache.copyVi.dataset.text = vi;
    cache.copyVi.disabled = false;
  } else {
    cache.copyVi.disabled = true;
  }
  // Keep EN text in sync with finalized phrases
  const en = finalizedEnPhrases[idx] || '';
  if (cache.enText && en && cache.enText.textContent !== en) {
    cache.enText.textContent = en;
    cache.copyEn.dataset.text = en;
  }
  const spk = utteranceSpeakers[idx];
  if (spk !== undefined && cache._speakerId !== spk) {
    applySpeakerToDom(cache, spk);
  }
}

// Update the suggest card for a given utterance index
// Inline card is now deprecated – suggestions are shown in the separated dock (like mockup).
// Keep function as no-op for compat but ensure dock stays in sync.
function updateSuggestCard(idx) {
  // Intentionally keep inline cards empty/hidden; dock is the single source of truth
  const cache = utteranceDomCache[idx];
  if (cache && cache.suggestCard) cache.suggestCard.innerHTML = '';
  // dock will be updated by caller via updateDock()
}

function setViText(el, vi) {
  if (vi === '…' || vi === undefined || vi === '') {
    // Keep the loading state only when there is no previous translation to show
    el.innerHTML = '<span class="vi-loading">Translating…</span>';
  } else {
    el.textContent = vi;
  }
}

// Smooth auto-scroll: sticky to TOP (newest on top) unless the user has scrolled down
// Optimized: instant for interim, smooth only for finalize; coalesced RAF
let scrollScheduled = false;
let pendingScrollForce = false;
let pendingScrollBehavior = 'smooth';
// Track whether the user wants sticky follow (true = near top or fresh session)
let shouldStickToTop = true;

function isNearTop() {
  if (!transcriptContent) return true;
  return transcriptContent.scrollTop < 120;
}
function autoScroll(force = false, behavior = 'smooth') {
  if (force) {
    pendingScrollForce = true;
    pendingScrollBehavior = 'smooth';
  } else if (behavior === 'smooth') {
    pendingScrollBehavior = 'smooth';
  } else {
    // interim uses instant to avoid jank
    if (pendingScrollBehavior !== 'smooth') pendingScrollBehavior = behavior;
  }
  const autoScrollCheck = document.getElementById('autoScrollCheck');
  const enabled = !!(autoScrollCheck && autoScrollCheck.checked);
  if (!enabled) return;
  if (!force) {
    if (!shouldStickToTop && !isNearTop()) return;
  }
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    const mustForce = pendingScrollForce;
    const beh = pendingScrollBehavior;
    pendingScrollForce = false;
    pendingScrollBehavior = 'smooth';
    if (!transcriptContent || !enabled) return;
    if (mustForce || shouldStickToTop || isNearTop()) {
      // newest is on top -> scroll to top (0)
      transcriptContent.scrollTo({
        top: 0,
        behavior: beh
      });
    }
  });
}
// escapeHtml already defined at top (pure utils) — keep single source

/** Hide placeholders — guarded */
function hidePlaceholders() {
  if (enPlaceholder) enPlaceholder.style.display = 'none';
  if (viPlaceholder) viPlaceholder.style.display = 'none';
  if (combinedPlaceholder) combinedPlaceholder.style.display = 'none';
}

/** Show placeholders if empty — guarded */
function showPlaceholders() {
  const hasData = finalizedEnPhrases.length > 0;
  if (!hasData) {
    if (combinedPlaceholder) combinedPlaceholder.style.display = 'flex';
    if (enPlaceholder) enPlaceholder.style.display = 'none';
    if (viPlaceholder) viPlaceholder.style.display = 'none';
  }
}

/** @param {boolean} active */
function updateUIForListening(active) {
  if (active) {
    toggleBtn.className = 'btn btn-danger btn-record';
    playIcon.style.display = 'none';
    stopIcon.style.display = 'block';
    btnText.innerText = 'Stop';
    logoDot.classList.add('listening');
    if (liveBadge) { liveBadge.textContent = '● LIVE'; liveBadge.classList.add('live'); }
    const footer = document.querySelector('.footer-status'); if (footer) footer.classList.add('live');
    toggleBtn.setAttribute('aria-label', 'Stop recording');
  } else {
    toggleBtn.className = 'btn btn-primary btn-record';
    playIcon.style.display = 'block';
    stopIcon.style.display = 'none';
    btnText.innerText = 'Start';
    logoDot.classList.remove('listening');
    if (liveBadge) { liveBadge.textContent = 'Offline'; liveBadge.classList.remove('live'); }
    const footer = document.querySelector('.footer-status'); if (footer) footer.classList.remove('live');
    toggleBtn.setAttribute('aria-label', 'Start recording');
  }
}

/** Clear all state — idempotent, awaited storage, no throw */
async function clearContent() {
  finalizedEnPhrases = [];
  finalizedViPhrases = [];
  utteranceSpeakers = [];
  questionSuggestions = {};
  utteranceDomCache = [];
  currentSpeakerId = 0;
  lastSpeakerFeatures = null;
  speakerVadLastSwitchAt = 0;
  lastFinalIndex = -1;
  finalizedOffset = 0;
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (liveViDebounce) {
    clearTimeout(liveViDebounce);
    liveViDebounce = null;
  }
  if (liveViController) {
    try { liveViController.abort(); } catch {}
    liveViController = null;
  }
  abortAllPendingTranslations();
  translationCache.clear();
  suggestQueue = Promise.resolve();
  
  if (englishLog) englishLog.innerHTML = '';
  if (englishInterim) englishInterim.innerText = '';
  if (vietnameseLog) vietnameseLog.innerHTML = '';
  if (vietnameseInterim) vietnameseInterim.innerText = '';
  if (transcriptFeed) transcriptFeed.innerHTML = '';
  if (interimBlock) interimBlock.style.display = 'none';
  if (combinedPlaceholder) combinedPlaceholder.style.display = 'flex';
  selectedQuestionIdx = null;
  // reset compress state as well
  compressedSummary = "";
  lastCompressedIdx = 0;
  try { await chrome.storage.local.set({ compressedSummary: "", lastCompressedIdx: 0 }); } catch {}
  updateCompressToggleUI();
  updateWordCounts();
  updateDock();
  
  // Clear summary output
  summaryPlaceholder.style.display = 'flex';
  summaryMarkdown.style.display = 'none';
  summaryMarkdown.innerHTML = '';
  summaryMarkdown.removeAttribute('data-raw-text');
  copySummaryBtn.style.display = 'none';
  
  showPlaceholders();
  showStatus('History cleared');
  setTimeout(() => {
    if (isListening) {
      if (activeAudioTrack) {
        showStatus('Translating Tab audio...');
      } else {
        showStatus('Listening for English (Mic)...');
      }
    } else {
      showStatus('Ready');
    }
  }, 1000);
}

// SETUP & GEMINI INTEGRATION LOGIC

/** Tab nav — ARIA, guarded */
function setupTabNavigation() {
  tabLive.addEventListener('click', () => {
    tabLive.classList.add('active');
    tabLive.setAttribute('aria-selected', 'true');
    tabSummary.classList.remove('active');
    tabSummary.setAttribute('aria-selected', 'false');
    liveTabContent.classList.add('active-tab-content');
    liveTabContent.style.display = 'flex';
    summaryTabContent.classList.remove('active-tab-content');
    summaryTabContent.style.display = 'none';
  });

  tabSummary.addEventListener('click', () => {
    tabSummary.classList.add('active');
    tabSummary.setAttribute('aria-selected', 'true');
    tabLive.classList.remove('active');
    tabLive.setAttribute('aria-selected', 'false');
    summaryTabContent.classList.add('active-tab-content');
    summaryTabContent.style.display = 'flex';
    liveTabContent.classList.remove('active-tab-content');
    liveTabContent.style.display = 'none';
    updateApiWarningState();
  });
}

/** Settings overlay — validated inputs, no throw */
function setupSettingsOverlay() {
  const presets = {
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
    ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' }
  };

  function fillSettings() {
    if (baseUrlInput) baseUrlInput.value = providerConfig.baseUrl || '';
    if (apiKeyInput) apiKeyInput.value = providerConfig.apiKey || '';
    if (modelInput) modelInput.value = providerConfig.model || '';
    if (geminiModelSelect) geminiModelSelect.value = providerConfig.model || '';
  }

  settingsBtn.addEventListener('click', () => {
    fillSettings();
    settingsOverlay.style.display = 'flex';
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsOverlay.style.display = 'none';
  });

  configNowBtn.addEventListener('click', () => {
    fillSettings();
    settingsOverlay.style.display = 'flex';
  });

  // preset chips
  document.querySelectorAll('.preset-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const p = presets[chip.dataset.preset];
      if (!p) return;
      if (baseUrlInput) baseUrlInput.value = p.baseUrl;
      if (modelInput) modelInput.value = p.model;
      document.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
  });

  toggleApiKeyVisibilityBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleApiKeyVisibilityBtn.innerText = '🔒';
    } else {
      apiKeyInput.type = 'password';
      toggleApiKeyVisibilityBtn.innerText = '👁️';
    }
  });

  saveSettingsBtn.addEventListener('click', () => {
    const baseUrl = (baseUrlInput ? baseUrlInput.value.trim().replace(/\/+$/, '') : providerConfig.baseUrl);
    const key = apiKeyInput.value.trim();
    const model = (modelInput ? modelInput.value.trim() : (geminiModelSelect ? geminiModelSelect.value : ''));

    if (!baseUrl) { showToast('Please enter Base URL', 'error'); baseUrlInput && baseUrlInput.focus(); return; }
    try { new URL(baseUrl); } catch { showToast('Invalid Base URL', 'error'); return; }
    if (!model) { showToast('Please enter Model', 'error'); modelInput && modelInput.focus(); return; }
    // API key can be empty for local Ollama, but warn if empty for remote
    const isLocal = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');
    if (!key && !isLocal) { showToast('Please enter API Key (or use localhost)', 'error'); apiKeyInput.focus(); return; }

    const toSave = {
      providerBaseUrl: baseUrl,
      providerApiKey: key,
      providerModel: model,
      // keep legacy keys for compat
      geminiApiKey: key,
      geminiModel: model,
      geminiBaseUrl: baseUrl
    };
    chrome.storage.local.set(toSave, () => {
      providerConfig.baseUrl = baseUrl;
      providerConfig.apiKey = key;
      providerConfig.model = model;
      geminiConfig = providerConfig;
      updateApiWarningState();
      settingsOverlay.style.display = 'none';
      showStatus('Provider configuration saved');
      showToast('Provider configuration saved', 'success');
    });
  });

  // Close overlay if clicking outside the modal card
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) {
      settingsOverlay.style.display = 'none';
    }
  });
}

// Load Provider Config from local storage (with migration from gemini keys)
async function loadProviderConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['providerBaseUrl','providerApiKey','providerModel','geminiBaseUrl','geminiApiKey','geminiModel'], (result) => {
      const baseUrl = result.providerBaseUrl || result.geminiBaseUrl || 'https://generativelanguage.googleapis.com/v1beta';
      const apiKey = result.providerApiKey !== undefined ? result.providerApiKey : (result.geminiApiKey || '');
      const model = result.providerModel || result.geminiModel || 'gemini-2.5-flash';
      providerConfig.baseUrl = baseUrl;
      providerConfig.apiKey = apiKey;
      providerConfig.model = model;
      geminiConfig = providerConfig;
      resolve();
    });
  });
}
async function loadGeminiConfig(){ return loadProviderConfig(); }

// Update API Warning Card Visibility (provider based)
function updateApiWarningState() {
  const isLocal = providerConfig.baseUrl && (providerConfig.baseUrl.includes('localhost') || providerConfig.baseUrl.includes('127.0.0.1'));
  const hasKey = !!providerConfig.apiKey || isLocal;
  const hasBase = !!providerConfig.baseUrl;
  const hasModel = !!providerConfig.model;
  if (!hasKey || !hasBase || !hasModel) {
    apiWarningCard.style.display = 'flex';
  } else {
    apiWarningCard.style.display = 'none';
  }
}

// Setup Summary Feature listeners (custom provider)
function setupSummaryFeatures() {
  generateSummaryBtn.addEventListener('click', generateSummary);
  // keep alias
  window.generateGeminiSummary = generateSummary;
  copySummaryBtn.addEventListener('click', () => {
    const text = summaryMarkdown.dataset.rawText;
    if (text) copyToClipboard(text, 'copySummaryBtn');
  });
}

// Call Custom Provider API to generate summary (supports Gemini + OpenAI-compatible)
async function generateSummary() {
  const englishText = getFullEnglishText();
  if (!englishText || englishText.trim() === '' ) {
    alert('No meeting content to summarize. Please record first.');
    return;
  }
  // provider validation
  if (!providerConfig.baseUrl || !providerConfig.model) {
    if (baseUrlInput) baseUrlInput.value = providerConfig.baseUrl || '';
    if (modelInput) modelInput.value = providerConfig.model || '';
    settingsOverlay.style.display = 'flex';
    alert('Please configure Base URL and Model.');
    return;
  }
  const isLocal = providerConfig.baseUrl.includes('localhost') || providerConfig.baseUrl.includes('127.0.0.1');
  if (!providerConfig.apiKey && !isLocal) {
    if (apiKeyInput) apiKeyInput.value = '';
    settingsOverlay.style.display = 'flex';
    alert('Please enter API Key.');
    return;
  }

  // Show loading
  summaryPlaceholder.style.display = 'none';
  summaryMarkdown.style.display = 'none';
  summaryLoading.style.display = 'flex';
  copySummaryBtn.style.display = 'none';
  // update loading text with provider
  const loadingP = summaryLoading.querySelector('p');
  if (loadingP) loadingP.textContent = `Analyzing with ${providerConfig.model}…`;

  const lang = summaryLangSelect.value;
  const detail = summaryDetailSelect.value;

  let prompt = '';
  if (lang === 'vi') {
    prompt = `You are a professional meeting assistant. Here is the meeting transcript in English:\n\n`;
    prompt += `"""\n${englishText}\n"""\n\n`;
    prompt += `Please generate a meeting summary in **Vietnamese** with the following requirements:\n`;
    if (detail === 'bullets') {
      prompt += `- Format as detailed bullet points grouped by topics or main parts discussed.\n`;
      prompt += `- Highlight key arguments or points raised by participants.\n`;
    } else if (detail === 'short') {
      prompt += `- Write a highly concise summary (max 2-3 short paragraphs) explaining the core topic and final conclusions.\n`;
    } else if (detail === 'action') {
      prompt += `- Extract and list Action Items, including who is responsible (if mentioned) and deadlines (if mentioned).\n`;
      prompt += `- Structure them clearly as a checklist or to-do list.\n`;
    }
    prompt += `- Format the output using clean Markdown, using headers (h2, h3) and bold text for emphasis. Do not use HTML.`;
  } else {
    prompt = `You are a professional meeting assistant. Here is the transcript of the meeting in English:\n\n`;
    prompt += `"""\n${englishText}\n"""\n\n`;
    prompt += `Please generate a meeting summary in **English** with the following requirements:\n`;
    if (detail === 'bullets') {
      prompt += `- Format as detailed bullet points grouped by topics or main parts discussed.\n`;
      prompt += `- Highlight key arguments or points raised by participants.\n`;
    } else if (detail === 'short') {
      prompt += `- Write a highly concise summary (max 2-3 short paragraphs) explaining the core topic and final conclusions.\n`;
    } else if (detail === 'action') {
      prompt += `- Extract and list Action Items, including who is responsible (if mentioned) and deadlines (if mentioned).\n`;
      prompt += `- Structure them clearly as a checklist or to-do list.\n`;
    }
    prompt += `- Format the output using clean Markdown, using headers (h2, h3) and bold text for emphasis. Do not use HTML.`;
  }

  const baseUrl = providerConfig.baseUrl.replace(/\/+$/, '');
  const model = providerConfig.model;
  const apiKey = providerConfig.apiKey;
  const isGemini = baseUrl.includes('generativelanguage.googleapis.com');

  try {
    let candidateText = '';

    if (isGemini) {
      // Gemini native format
      const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
      const headers = { 'Content-Type': 'application/json' };
      // if baseUrl is custom but still Gemini format, use key query
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try { const errData = await response.json(); errMsg = errData.error?.message || errMsg; } catch {}
        throw new Error(errMsg);
      }
      const data = await response.json();
      candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      // OpenAI-compatible /chat/completions
      const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const body = {
        model,
        messages: [
          { role: 'system', content: 'You are a helpful meeting assistant that outputs clean Markdown.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7
      };
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try { const errData = await response.json(); errMsg = errData.error?.message || errData.error || errMsg; } catch {}
        throw new Error(errMsg);
      }
      const data = await response.json();
      candidateText = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
      // Ollama sometimes returns { message: { content } } or array
      if (!candidateText && data.message?.content) candidateText = data.message.content;
    }

    if (!candidateText) throw new Error('API returned no content.');

    const renderedHtml = parseMarkdown(candidateText);
    summaryMarkdown.innerHTML = renderedHtml;
    summaryMarkdown.dataset.rawText = candidateText;
    summaryLoading.style.display = 'none';
    summaryMarkdown.style.display = 'block';
    copySummaryBtn.style.display = 'flex';
    showStatus('Summary generated successfully');
    showToast(`Summarized with ${model} successfully`, 'success');
  } catch (error) {
    console.error('Provider error:', error);
    summaryLoading.style.display = 'none';
    summaryPlaceholder.style.display = 'flex';
    summaryPlaceholder.innerHTML = `<span style="color: #ef4444;">⚠️ Error generating summary (${escapeHtml(providerConfig.baseUrl)}): ${escapeHtml(error.message)}. Check Base URL / Model / API Key.</span>`;
    showStatus('Summary generation error');
    showToast(error.message, 'error');
  }
}
async function generateGeminiSummary(){ return generateSummary(); }

// Simple and Safe Client-side Markdown Parser to HTML
function parseMarkdown(md) {
  if (!md) return '';
  
  // Escape HTML tags to prevent XSS
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Split into lines to parse block elements
  const lines = html.split(/\r?\n/);
  let result = [];
  let inList = false;
  let listType = ''; // 'ul' or 'ol'

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    // Check for headers
    if (line.startsWith('### ')) {
      if (inList) { result.push(`</${listType}>`); inList = false; }
      result.push(`<h3>${parseInlineMarkdown(line.substring(4))}</h3>`);
      continue;
    }
    if (line.startsWith('## ')) {
      if (inList) { result.push(`</${listType}>`); inList = false; }
      result.push(`<h2>${parseInlineMarkdown(line.substring(3))}</h2>`);
      continue;
    }
    if (line.startsWith('# ')) {
      if (inList) { result.push(`</${listType}>`); inList = false; }
      result.push(`<h1>${parseInlineMarkdown(line.substring(2))}</h1>`);
      continue;
    }

    // Check for blockquotes
    if (line.startsWith('&gt; ')) {
      if (inList) { result.push(`</${listType}>`); inList = false; }
      result.push(`<blockquote>${parseInlineMarkdown(line.substring(5))}</blockquote>`);
      continue;
    }

    // Check for bullet list items
    if (line.startsWith('- ') || line.startsWith('* ')) {
      if (!inList || listType !== 'ul') {
        if (inList) { result.push(`</${listType}>`); }
        result.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      result.push(`<li>${parseInlineMarkdown(line.substring(2))}</li>`);
      continue;
    }

    // Check for numbered list items (e.g., "1. Item")
    const numListMatch = line.match(/^(\d+)\.\s+(.*)$/);
    if (numListMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) { result.push(`</${listType}>`); }
        result.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      result.push(`<li>${parseInlineMarkdown(numListMatch[2])}</li>`);
      continue;
    }

    // Empty line
    if (line === '') {
      if (inList) {
        result.push(`</${listType}>`);
        inList = false;
      }
      continue;
    }

    // Normal paragraph line
    if (inList) {
      result.push(`</${listType}>`);
      inList = false;
    }
    result.push(`<p>${parseInlineMarkdown(line)}</p>`);
  }

  if (inList) {
    result.push(`</${listType}>`);
  }

  return result.join('\n');
}

function parseInlineMarkdown(text) {
  // Parse bold **text**
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  // Parse italic *text*
  text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
  
  // Parse inline code `code`
  text = text.replace(/`(.*?)`/g, '<code>$1</code>');

  return text;
}

/** @param {string} msg */
function showStatus(msg) {
  if (!statusText) return;
  // statusText contains dot + span, preserve structure if exists
  const span = statusText.querySelector('span:last-child');
  if (span) span.innerText = msg;
  else statusText.innerText = msg;
}

/** Update word counts — pure calc, guarded DOM */
function updateWordCounts() {
  const enText = finalizedEnPhrases.join(' ').trim();
  const viText = finalizedViPhrases.join(' ').trim();
  const enCount = enText ? enText.split(/\s+/).length : 0;
  const viCount = viText ? viText.split(/\s+/).length : 0;
  const total = enCount + viCount;
  if (enWordCount) enWordCount.textContent = enCount + ' words';
  if (viWordCount) viWordCount.textContent = viCount + ' words';
  if (combinedWordCount) combinedWordCount.textContent = total ? `${enCount} EN • ${viCount} VI` : '0 words';
}

/** Schedule RAF word count — idempotent */
function scheduleWordCountUpdate() {
  if (wordCountRaf) return;
  wordCountRaf = requestAnimationFrame(() => {
    wordCountRaf = null;
    updateWordCounts();
  });
}

/** Show toast — validated, auto-dismiss, no throw */
function showToast(message, type = 'default') {
  if (!toastContainer) return;
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  const icon = type === 'success' ? '✅' : type === 'error' ? '⚠️' : '💬';
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${message}</span>`;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s forwards';
    setTimeout(() => toast.remove(), 300);
  }, 2600);
}

/** Keyboard shortcuts — guarded, no repeat, ARIA */
function setupKeyboardShortcuts() {
  /** @param {EventTarget|null} t */
  const isTypingTarget = (t) => {
    try { return !!(t instanceof Element && t.matches('input, textarea, select')); } catch { return false; }
  };
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTypingTarget(e.target)) {
      e.preventDefault();
      toggleListening();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      clearContent();
      showToast('History cleared', 'success');
    }
    if (e.key === 'Escape') {
      if (settingsOverlay) settingsOverlay.style.display = 'none';
      if (permissionOverlay) permissionOverlay.style.display = 'none';
    }
    // Live sub-view shortcuts: 1/2/3/4 → Transcript/Answers/Context/Both (live tab only, not while typing)
    if ((e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') && !e.ctrlKey && !e.metaKey && !e.altKey
        && !isTypingTarget(e.target)
        && typeof liveTabContent !== 'undefined' && liveTabContent
        && liveTabContent.classList.contains('active-tab-content')) {
      e.preventDefault();
      setLiveView(e.key === '1' ? 'transcript' : e.key === '2' ? 'answers' : e.key === '3' ? 'context' : 'split');
    }
  });
  // ARIA tab handling
  if (tabLive && tabSummary) {
    [tabLive, tabSummary].forEach(btn => {
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const other = btn === tabLive ? tabSummary : tabLive;
          other.focus(); other.click();
        }
      });
    });
  }
}

/** @returns {string} */
function getFullEnglishText() {
  const final = finalizedEnPhrases.filter(Boolean).join(' ');
  return final.trim();
}

/** @returns {string} */
function getFullVietnameseText() {
  const final = finalizedViPhrases.filter(v => v && v !== '…' && v !== '[Translation failed]').join(' ');
  return final.trim();
}

/** Copy with fallback, toast, validated */
async function copyToClipboard(text, buttonId) {
  try {
    await navigator.clipboard.writeText(text);
    const button = document.getElementById(buttonId);
    const originalHTML = button.innerHTML;
    button.innerHTML = `
      <svg viewBox="0 0 24 24" style="fill: var(--success);">
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
      </svg>
    `;
    showToast('Copied to clipboard', 'success');
    setTimeout(() => {
      button.innerHTML = originalHTML;
    }, 1500);
  } catch (err) {
    console.error('Failed to copy:', err);
    showToast('Copy failed', 'error');
  }
}
