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
  COMPRESS_INTERVAL_MS: 10 * 60 * 1000,
  COMPRESS_RECENT_KEEP: 10,
  COMPRESS_MAX_CHARS: 6000,
  MEMORY_BUDGET: 30000,
  SUGGEST_CTX_FAST: 8000,
  SUGGEST_CTX_QUALITY: 12000,
  SUGGEST_RECENT_FAST: 3000,
  SUGGEST_RECENT_QUALITY: 4000,
  // Summary coverage (fix: 1h meeting lost its first 30m):
  // - FULL_HISTORY_MAX keeps an append-only archive of every finalized utterance
  // - SUMMARY_CHUNK_CHARS splits long meetings into map-reduce chunks (no truncation)
  // - COMPRESSED_SUMMARY_MAX keeps rolling bullets for ~2h of 5-min compressions
  FULL_HISTORY_MAX_UTTERANCES: 5000,
  SUMMARY_CHUNK_CHARS: 12000,
  COMPRESSED_SUMMARY_MAX_CHARS: 15000,
  COMPRESS_SEGMENT_MAX_CHARS: 12000,
  SPEAKER_VAD_RMS_THRESH: 0.012,
  SPEAKER_MIN_PAUSE_MS: 350,
  SPEAKER_MIN_SPEECH_MS: 600,
  SPEAKER_CENTROID_DIFF: 320,
  TRANSLATE_TIMEOUT_MS: 8500,
  TRANSLATE_FALLBACK_ENABLED: true,
  TRANSLATE_FALLBACK_TIMEOUT_MS: 8000,
  TRANSLATE_AI_FALLBACK_TIMEOUT_MS: 15000,
  MYMEMORY_MAX_CHARS: 450,
  STORAGE_KEYS: Object.freeze({
    suggestEnabled: 'suggestEnabled',
    compressEnabled: 'compressEnabled',
    compressedSummary: 'compressedSummary',
    lastCompressedIdx: 'lastCompressedIdx',
    suggestContextPrompt: 'suggestContextPrompt',
    providerBaseUrl: 'providerBaseUrl',
    providerApiKey: 'providerApiKey',
    providerModel: 'providerModel',
    providerThinkingEnabled: 'providerThinkingEnabled',
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
const MEMORY_BUDGET = CONFIG.MEMORY_BUDGET || 30000;
const FULL_HISTORY_MAX_UTTERANCES = CONFIG.FULL_HISTORY_MAX_UTTERANCES;
const SUMMARY_CHUNK_CHARS = CONFIG.SUMMARY_CHUNK_CHARS;
const COMPRESSED_SUMMARY_MAX_CHARS = CONFIG.COMPRESSED_SUMMARY_MAX_CHARS;
const COMPRESS_SEGMENT_MAX_CHARS = CONFIG.COMPRESS_SEGMENT_MAX_CHARS;
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
  // Append-only archive of EVERY finalized EN utterance (never compacted).
  // AI summary reads this so hour-long meetings keep head content after the
  // live window above is compacted. Capped at FULL_HISTORY_MAX_UTTERANCES.
  fullEnHistory: /** @type {string[]} */([]),
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
  suggestCache: new Map(),
  suggestInFlight: new Map(),
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
let fullEnHistory = State.fullEnHistory;
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
/** Live sub-view: 'transcript' | 'answers' | 'split' — view-only, no transcript logic depends on it.
 * 'context' is a top-level stepper tab now; setLiveView('context') routes there. */
let liveView = 'transcript';
/**
 * Switch live sub-view — guarded, no throw. Sections keep their IDs so all
 * existing logic (dock render, inspector, compress) works in any view.
 * 'split' shows transcript + answers stacked together.
 * @param {string} name
 */
function setLiveView(name) {
  if (name === 'context') { switchTopTab('context'); return; }
  if (name !== 'transcript' && name !== 'answers' && name !== 'split') return;
  liveView = name;
  try {
    const map = {
      transcript: document.getElementById('transcriptSection'),
      answers: document.getElementById('suggestionDock'),
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
/** Transcript settings dropdown (⚙️) — guarded, persists open state */
function setupTranscriptSettings() {
  try {
    const btn = document.getElementById('transcriptSettingsBtn');
    const panel = document.getElementById('transcriptSettings');
    if (!btn || !panel) return;
    const setOpen = (open) => {
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      try { localStorage.setItem('transcript_settings_open', open ? '1' : '0'); } catch {}
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(panel.hidden);
    });
    document.addEventListener('click', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) { setOpen(false); btn.focus(); }
    });
    let saved = null;
    try { saved = localStorage.getItem('transcript_settings_open'); } catch {}
    if (saved === '1') setOpen(true);
  } catch (e) { console.warn('[setupTranscriptSettings]', e); }
}

/* ============================================================
   I18N — full VI/EN interface language. Default 'vi' (current UI).
   - Static HTML uses data-i18n / data-i18n-ph / data-i18n-title / data-i18n-aria.
   - Structural JS strings use i18nT('key', {vars}).
   - Toasts/statuses pass through tt(msg): central EN<->VI map so all
     ~60 call sites translate without per-site edits. Unknown messages
     pass through unchanged. Persisted like theme (localStorage + chrome.storage).
   ============================================================ */
const I18N = {
  vi: {
    app_title: 'Live Translate (EN → VI)',
    app_subtitle: 'Trợ lý Dịch Song Ngữ & Gợi Ý Trả Lời Trực Tiếp',
    badge_idle: 'Chế độ chờ',
    badge_live: '● Đang ghi nhận',
    audio_tab: 'Tab', audio_mic: 'Mic',
    opt_tab_audio: '🌐 Âm thanh Tab', opt_mic: '🎙️ Micrô',
    start_live: '▶ Bắt đầu Live', stop_live: '■ Dừng Live',
    clear_title: 'Xóa nội dung (Ctrl+K)',
    mem_title: '🧠 Dung lượng bộ nhớ',
    mem_meta: '{used} / {budget} ký tự • {n} câu • {q} câu hỏi',
    btn_compress: 'Compress', btn_copy: '⧉ Copy',
    step_context: 'Ngữ cảnh', step_live: 'Live', step_summary: 'Tổng kết',
    step_context_title: 'Bước 1 — Cung cấp ngữ cảnh',
    step_live_title: 'Bước 2 — Phụ đề & Trợ lý Live',
    step_summary_title: 'Bước 3 — AI Tổng kết cuộc họp',
    ctx_title: 'Cung cấp ngữ cảnh',
    ctx_desc: 'Chọn mẫu nhanh hoặc nhập hint để AI gợi ý câu trả lời sát tình huống hơn.',
    suggest_ctx: 'Ngữ cảnh gợi ý',
    saved_badge: 'Đã lưu',
    ctx_placeholder: 'e.g. daily meeting with dev team • frontend interview call • product demo for client...',
    ctx_hint: 'Chỉ dùng cho gợi ý trả lời — không ảnh hưởng tổng kết AI',
    presets_label: 'Mẫu nhanh:',
    preset_interview: 'Phỏng vấn', preset_class: 'Lớp học', preset_sales: 'Bán hàng', preset_negotiation: 'Đàm phán',
    search_ph: 'Tìm kiếm phụ đề…', search_aria: 'Tìm trong phụ đề',
    filter_q: '❓ Chỉ hỏi', filter_q_title: 'Chỉ hiện câu hỏi',
    submode_both: 'EN+VI', submode_en: 'EN', submode_vi: 'VI',
    settings_title: 'Cài đặt phụ đề',
    ai_suggest: '💡 AI gợi ý',
    compress_10m: '🗜️ Compress 10m',
    auto_translate: '🌐 Auto dịch • Google',
    auto_translate_title: 'Bản dịch tiếng Việt được dịch tự động qua Google Translate (miễn phí, không cần API key)',
    count_speech: '{n} thoại',
    words: 'từ', no_words: '0 từ',
    ready_title: 'Sẵn sàng ghi',
    ready_desc_html: 'Bấm <strong>Start</strong> và nói tiếng Anh. Mỗi câu tiếng Anh hiện phía trên bản dịch tiếng Việt.',
    dock_title: 'Gợi ý trả lời', dock_aria: 'Khung gợi ý trả lời',
    q_count: '{n} câu hỏi',
    dock_both: 'Cả hai', dock_structure: 'Dàn ý', dock_full: 'Đầy đủ', dock_clear: 'Xóa',
    suggest_empty: 'Chưa có câu hỏi. Khi AI phát hiện câu hỏi, gợi ý sẽ hiện ở đây.',
    q_zone_need: '❓ CÂU HỎI #{n} • CẦN TRẢ LỜI', q_zone_done: '❓ CÂU HỎI #{n} • ĐÃ XONG ✓',
    mark_said: 'Đánh dấu đã nói', marked_done: '✓ Đã xong',
    trans_label: 'Dịch',
    speak_q: '🔊 Phát âm', speak_title: 'Speak question',
    speak_this: '🔊 Phát âm', speak_this_title: 'Phát âm câu này',
    quick_label: '⚡ TRẢ LỜI NHANH (QUICK REPLIES)',
    complete_label: 'Câu trả lời hoàn chỉnh',
    q_flag: 'CÂU HỎI PHÁT HIỆN', view_cta: '⚡ Xem gợi ý', view_cta_title: 'Jump to suggested answers',
    tone_confident: 'Tự tin & Năng động', tone_pro: 'Chuyên nghiệp & Điềm tĩnh', tone_concise: 'Ngắn gọn & Trọng tâm',
    no_complete: 'No complete answers yet — try regenerating.',
    generating_for: 'Đang sinh gợi ý cho:',
    warn_title: 'Chưa cấu hình AI Provider',
    warn_desc: 'Thêm Base URL, Model và API Key để dùng tổng kết AI.',
    config_now: 'Cấu hình ngay',
    summarize: 'Tổng kết',
    summary_result: 'Kết quả tổng kết',
    no_summary_title: 'Chưa có tổng kết',
    no_summary_desc: 'Khi đã có phụ đề, bấm “Tổng kết” để phân tích bằng Gemini.',
    analyzing: 'Gemini đang phân tích…', analyzing_sub: 'Có thể mất 5–10 giây',
    summarizing_part: 'Đang tổng kết phần {i}/{n} với {m}…',
    merging_parts: 'Đang gộp {n} phần với {m}…',
    analyzing_with: 'Đang phân tích với {m}…',
    translating_short: 'Đang dịch…',
    select_q: 'Chọn một câu hỏi phía trên để xem gợi ý.',
    retry_btn: 'Thử lại',
    err_summary: '⚠️ Lỗi tạo tổng kết ({u}): {e}. Kiểm tra Base URL / Model / API Key.',
    md_progress: '{d} / {t} hoàn thành',
    autoscroll: 'Tự động cuộn', autoscroll_title: 'Tự động cuộn khi có nội dung mới',
    skip_link: 'Bỏ qua tới nội dung chính',
    help_title: '🗺️ Bản đồ màu & trọng tâm',
    help_am_t: '🟧 Cam / Amber = Câu hỏi', help_am_d: 'Câu hỏi được phát hiện có viền cam + nút “Xem gợi ý trả lời”.',
    help_sky_t: '🟦 Xanh dương = Gợi ý nhanh', help_sky_d: 'Các ý ngắn 1–2–3 để phản xạ tức thì.',
    help_em_t: '🟩 Xanh lá = Câu trả lời hoàn chỉnh', help_em_d: 'Bài nói đầy đủ theo phong cách + nút 🔊 phát âm.',
    help_nt_t: '⬛ Sáng / Tối', help_nt_d: 'Nút ☀️/🌙 trên header chuyển theme, lưu tự động.',
    help_gotit: 'Đã hiểu & tiếp tục',
    cfg_title: 'Cấu hình AI Provider',
    cfg_base: 'Base URL', cfg_key: 'API Key', cfg_model: 'Model',
    cfg_key_help: 'Để trống nếu dùng Ollama trên máy.',
    cfg_model_help: 'Nhập chính xác tên model của provider.',
    cfg_thinking: 'Thinking',
    cfg_thinking_help: 'OFF = model trả lời trực tiếp, không reasoning/thinking (nhanh hơn).',
    cfg_save: 'Lưu cấu hình',
    cfg_foot_html: 'Hỗ trợ API tương thích OpenAI. Với Gemini dùng định dạng <code>generativelanguage</code>.',
    perm_title: 'Microphone permission required',
    perm_desc: 'Allow microphone access for speech recognition. You can change this in Chrome settings.',
    perm_open: 'Open permission page', perm_later: 'Later',
    cmp_pending: '🗜️ Pending: {n} sentences waiting (auto every 10m)',
    cmp_done: '🗜️ Compressed {n} sentences • {p} pending • {c} chars',
    cmp_manual_title: 'Nén ngay {n} câu đang chờ',
    cmp_manual_empty: 'Chưa đủ câu để nén',
    cmp_badge: '🗜️ Đã nén {n} câu',
    cmp_badge_waiting: 'Đang chờ nén…',
    cmp_waiting: '🗜️ Đã bật nén 10p — đang chờ phụ đề…',
    lang_btn_title_vi: 'Chuyển sang tiếng Anh (Switch to English)',
    lang_btn_title_en: 'Switch to Vietnamese (Chuyển sang tiếng Việt)',
    speaker_a: 'Người nói A', speaker_b: 'Người nói B', speaker_q: 'Người hỏi',
    rec_title: 'Bắt đầu ghi (Space)',
    rec_controls: 'Điều khiển ghi',
    audio_src: 'Nguồn âm thanh',
    steps_aria: 'Các bước thực hiện',
    live_views_aria: 'Chế độ xem live',
    submode_aria: 'Chế độ hiển thị phụ đề',
    sugg_mode_aria: 'Chế độ gợi ý',
    q_list_aria: 'Danh sách câu hỏi',
    sum_lang_aria: 'Ngôn ngữ tổng kết',
    sum_type_aria: 'Kiểu tổng kết',
    sum_detailed: '📝 Chi tiết', sum_executive: '⚡ Tóm tắt', sum_action: '🎯 Việc cần làm',
    dock_clear_title: 'Xóa gợi ý',
    dl_title: 'Tải tổng kết (.md)', cp_title: 'Sao chép tổng kết',
    show_hide: 'Hiện/Ẩn',
    theme_light_title: 'Giao diện sáng', theme_dark_title: 'Giao diện tối',
    help_btn_title: 'Chú thích màu & trợ giúp',
    ai_cfg_title: 'Cấu hình AI Provider (Ctrl+,)',
    live_v_transcript: '💬 Phụ đề', live_v_answers: '✦ Gợi ý', live_v_split: '◫ Song song',
  },
  en: {
    app_title: 'Live Translate (EN → VI)',
    app_subtitle: 'Bilingual Translation Assistant & Live Answer Suggestions',
    badge_idle: 'Idle',
    badge_live: '● Recording',
    audio_tab: 'Tab', audio_mic: 'Mic',
    opt_tab_audio: '🌐 Tab Audio', opt_mic: '🎙️ Microphone',
    start_live: '▶ Start Live', stop_live: '■ Stop Live',
    clear_title: 'Clear content (Ctrl+K)',
    mem_title: '🧠 Memory usage',
    mem_meta: '{used} / {budget} chars • {n} sentences • {q} questions',
    btn_compress: 'Compress', btn_copy: '⧉ Copy',
    step_context: 'Context', step_live: 'Live', step_summary: 'Summary',
    step_context_title: 'Step 1 — Provide context',
    step_live_title: 'Step 2 — Live subtitles & assistant',
    step_summary_title: 'Step 3 — AI meeting summary',
    ctx_title: 'Provide context',
    ctx_desc: 'Pick a quick preset or type a hint so AI suggestions match your situation.',
    suggest_ctx: 'Suggestion Context',
    saved_badge: 'Saved',
    ctx_placeholder: 'e.g. daily meeting with dev team • frontend interview call • product demo for client...',
    ctx_hint: 'Used only for answer suggestions — does not affect AI summary',
    presets_label: 'Presets:',
    preset_interview: 'Interview', preset_class: 'Class', preset_sales: 'Sales', preset_negotiation: 'Negotiation',
    search_ph: 'Search subtitles…', search_aria: 'Search transcript',
    filter_q: '❓ Questions', filter_q_title: 'Show questions only',
    submode_both: 'EN+VI', submode_en: 'EN', submode_vi: 'VI',
    settings_title: 'Transcript settings',
    ai_suggest: '💡 AI suggestions',
    compress_10m: '🗜️ Compress 10m',
    auto_translate: '🌐 Auto-translate • Google',
    auto_translate_title: 'Vietnamese translations come automatically via Google Translate (free, no API key needed)',
    count_speech: '{n} utterances',
    words: 'words', no_words: '0 words',
    ready_title: 'Ready to record',
    ready_desc_html: 'Click <strong>Start</strong> and speak English. Each English sentence appears above its Vietnamese translation.',
    dock_title: 'Suggested Answers', dock_aria: 'Suggested Answers',
    q_count: '{n} questions',
    dock_both: 'Both', dock_structure: 'Structure', dock_full: 'Full', dock_clear: 'Clear',
    suggest_empty: 'No questions yet. When AI detects a question, suggestions will appear here.',
    q_zone_need: '❓ QUESTION #{n} • NEEDS ANSWER', q_zone_done: '❓ QUESTION #{n} • DONE ✓',
    mark_said: 'Mark as said', marked_done: '✓ Done',
    trans_label: 'Translation',
    speak_q: '🔊 Speak', speak_title: 'Speak question',
    speak_this: '🔊 Speak', speak_this_title: 'Speak this sentence',
    quick_label: '⚡ QUICK REPLIES',
    complete_label: 'Complete answers',
    q_flag: 'QUESTION DETECTED', view_cta: '⚡ View suggestions', view_cta_title: 'Jump to suggested answers',
    tone_confident: 'Confident & Dynamic', tone_pro: 'Professional & Calm', tone_concise: 'Concise & Focused',
    no_complete: 'No complete answers yet — try regenerating.',
    generating_for: 'Generating suggestions for:',
    warn_title: 'AI Provider not configured',
    warn_desc: 'Add Base URL, Model and API Key to use AI summary.',
    config_now: 'Configure now',
    summarize: 'Summarize',
    summary_result: 'Summary result',
    no_summary_title: 'No summary yet',
    no_summary_desc: 'Once you have a transcript, click “Summarize” to analyze with Gemini.',
    analyzing: 'Gemini is analyzing…', analyzing_sub: 'May take 5–10 seconds',
    summarizing_part: 'Summarizing part {i}/{n} with {m}…',
    merging_parts: 'Merging {n} parts with {m}…',
    analyzing_with: 'Analyzing with {m}…',
    translating_short: 'Translating…',
    select_q: 'Select a question above to view suggestions.',
    retry_btn: 'Retry',
    err_summary: '⚠️ Error generating summary ({u}): {e}. Check Base URL / Model / API Key.',
    md_progress: '{d} / {t} done',
    autoscroll: 'Auto-scroll', autoscroll_title: 'Auto-scroll when new content arrives',
    skip_link: 'Skip to main content',
    help_title: '🗺️ Color map & focus',
    help_am_t: '🟧 Orange / Amber = Question', help_am_d: 'Detected questions get an orange border + “View suggestions” button.',
    help_sky_t: '🟦 Blue = Quick replies', help_sky_d: 'Short 1–2–3 ideas for instant reflex answers.',
    help_em_t: '🟩 Green = Complete answer', help_em_d: 'Full styled speech + 🔊 speak button.',
    help_nt_t: '⬛ Light / Dark', help_nt_d: '☀️/🌙 buttons in the header switch theme, auto-saved.',
    help_gotit: 'Got it',
    cfg_title: 'AI Provider Configuration',
    cfg_base: 'Base URL', cfg_key: 'API Key', cfg_model: 'Model',
    cfg_key_help: 'Leave empty for local Ollama.',
    cfg_model_help: 'Enter the exact provider model name.',
    cfg_thinking: 'Thinking',
    cfg_thinking_help: 'OFF = model answers directly without reasoning/thinking (faster).',
    cfg_save: 'Save configuration',
    cfg_foot_html: 'Supports OpenAI-compatible API. For Gemini use <code>generativelanguage</code> format.',
    perm_title: 'Microphone permission required',
    perm_desc: 'Allow microphone access for speech recognition. You can change this in Chrome settings.',
    perm_open: 'Open permission page', perm_later: 'Later',
    cmp_pending: '🗜️ Pending: {n} sentences waiting (auto every 10m)',
    cmp_done: '🗜️ Compressed {n} sentences • {p} pending • {c} chars',
    cmp_manual_title: 'Compress now {n} pending sentences',
    cmp_manual_empty: 'Not enough sentences to compress',
    cmp_badge: '🗜️ Compressed {n} sentences',
    cmp_badge_waiting: 'Waiting to compress…',
    cmp_waiting: '🗜️ 10m compression enabled — waiting for transcript…',
    lang_btn_title_vi: 'Chuyển sang tiếng Anh (Switch to English)',
    lang_btn_title_en: 'Switch to Vietnamese (Chuyển sang tiếng Việt)',
    speaker_a: 'Speaker A', speaker_b: 'Speaker B', speaker_q: 'Interviewer',
    rec_title: 'Start recording (Space)',
    rec_controls: 'Recording controls',
    audio_src: 'Audio source',
    steps_aria: 'Workflow steps',
    live_views_aria: 'Live views',
    submode_aria: 'Subtitle display mode',
    sugg_mode_aria: 'Chế độ gợi ý',
    q_list_aria: 'Danh sách câu hỏi',
    sum_lang_aria: 'Ngôn ngữ tổng kết',
    sum_type_aria: 'Kiểu tổng kết',
    sum_detailed: '📝 Detailed', sum_executive: '⚡ Executive', sum_action: '🎯 Action Items',
    dock_clear_title: 'Clear suggestions',
    dl_title: 'Download summary (.md)', cp_title: 'Copy summary',
    show_hide: 'Show/Hide',
    theme_light_title: 'Light theme', theme_dark_title: 'Dark theme',
    help_btn_title: 'Color legend & help',
    ai_cfg_title: 'Configure AI Provider (Ctrl+,)',
    live_v_transcript: '💬 Transcript', live_v_answers: '✦ Answers', live_v_split: '◫ Split',
  },
};
/* Preset prompts follow UI language (they steer the AI persona) */
const I18N_PROMPTS = {
  vi: [
    'Đây là buổi phỏng vấn xin việc bằng tiếng Anh. Hãy đóng vai ứng viên tự tin, cung cấp câu trả lời chuyên sâu, dẫn chứng số liệu cụ thể.',
    'Đây là buổi học trực tuyến kèm hỏi đáp tiếng Anh. Tập trung vào giải thích từ vựng, ngữ pháp và phát âm chuẩn xác.',
    'Đây là buổi thuyết trình giải pháp cho khách hàng. Hãy đóng vai chuyên gia tư vấn sắc bén, nêu bật USP và ROI.',
    'Đây là buổi thương thảo hợp đồng kinh doanh. Cung cấp câu trả lời mềm mỏng, quyết đoán và bảo vệ quyền lợi tối đa.',
  ],
  en: [
    'This is an English job interview. Act as a confident candidate giving in-depth answers with specific numbers and evidence.',
    'This is an online class with English Q&A. Focus on explaining vocabulary, grammar and accurate pronunciation.',
    'This is a solution pitch to a client. Act as a sharp consultant, highlighting unique selling points and ROI.',
    'This is a business contract negotiation. Give tactful, decisive answers that protect our interests.',
  ],
};
let appLang = 'vi';
/** Translate a dict key with {var} interpolation. Falls back to VI, then key. */
function i18nT(key, vars) {
  const d = (I18N[appLang] && I18N[appLang][key] !== undefined) ? I18N[appLang][key] : (I18N.vi[key] !== undefined ? I18N.vi[key] : key);
  if (!vars) return d;
  return String(d).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : '{' + k + '}'));
}
/* Toast/status passthrough translator. [en, vi] pairs; '#' = any number run. */
const MSG_PAIRS = [
  ['Ready', 'Sẵn sàng'],
  ['Stopped', 'Đã dừng'],
  ['Connecting to Tab audio...', 'Đang kết nối âm thanh Tab...'],
  ['Cannot capture this tab.', 'Không thể thu âm tab này.'],
  ['Tab audio connection error.', 'Lỗi kết nối âm thanh Tab.'],
  ['Microphone permission required', 'Cần quyền micro'],
  ['Translating Tab audio...', 'Đang dịch âm thanh Tab...'],
  ['Listening for English (Mic)...', 'Đang nghe tiếng Anh (Mic)...'],
  ['Translating...', 'Đang dịch...'],
  ['Mic error', 'Lỗi mic'],
  ['STT network error', 'Lỗi mạng STT'],
  ['Compressing history… (agent)', 'Đang nén lịch sử…'],
  ['History cleared', 'Đã xóa lịch sử'],
  ['Provider configuration saved', 'Đã lưu cấu hình provider'],
  ['Summary generated successfully', 'Tạo tổng kết thành công'],
  ['Summary generation error', 'Lỗi tạo tổng kết'],
  ['Context cleared', 'Đã xóa ngữ cảnh'],
  ['Initialization error', 'Lỗi khởi tạo'],
  ['AI suggestions enabled', 'Đã bật gợi ý AI'],
  ['AI suggestions disabled', 'Đã tắt gợi ý AI'],
  ['History compression enabled (10m)', 'Đã bật nén lịch sử (10p)'],
  ['History compression disabled', 'Đã tắt nén lịch sử'],
  ['Enable 10m compression before manual compress', 'Bật nén 10p trước khi nén thủ công'],
  ['Context copied', 'Đã sao chép ngữ cảnh'],
  ['Copy failed', 'Sao chép thất bại'],
  ['No content', 'Chưa có nội dung'],
  ['No translation', 'Chưa có bản dịch'],
  ['Failed to open permission page', 'Không mở được trang quyền'],
  ['Browser does not support Speech Recognition', 'Trình duyệt không hỗ trợ nhận diện giọng nói'],
  ['Browser does not support SpeechRecognition', 'Trình duyệt không hỗ trợ nhận diện giọng nói'],
  ['Failed to start recording', 'Không bắt đầu ghi được'],
  ['Mic not found — check device', 'Không thấy mic — kiểm tra thiết bị'],
  ['STT network error — retrying', 'Lỗi mạng STT — đang thử lại'],
  ['Auto-restart failed', 'Tự khởi động lại thất bại'],
  ['AI Provider not configured for compression', 'Chưa cấu hình AI để nén'],
  ['Not enough sentences to compress', 'Chưa đủ câu để nén'],
  ['Compression returned empty', 'Nén trả về rỗng'],
  ['Suggestions cleared', 'Đã xóa gợi ý'],
  ['Copied', 'Đã sao chép'],
  ['Copied to clipboard', 'Đã sao chép vào clipboard'],
  ['TTS not supported', 'Không hỗ trợ đọc TTS'],
  ['Context preset applied', 'Đã áp dụng mẫu ngữ cảnh'],
  ['Full context copied', 'Đã sao chép full context'],
  ['No summary to download', 'Chưa có tổng kết để tải'],
  ['Downloaded .md', 'Đã tải .md'],
  ['Download failed', 'Tải thất bại'],
  ['Please enter Base URL', 'Vui lòng nhập Base URL'],
  ['Invalid Base URL', 'Base URL không hợp lệ'],
  ['Please enter Model', 'Vui lòng nhập Model'],
  ['Please enter API Key (or use localhost)', 'Vui lòng nhập API Key (hoặc dùng localhost)'],
  ['Compressed # sentences', 'Đã nén # câu'],
];
const MSG_EXACT = new Map();
MSG_PAIRS.forEach(([en, vi]) => {
  const entry = { en, vi };
  MSG_EXACT.set(String(en).replace(/\d[\d.,]*/g, '#'), entry);
  MSG_EXACT.set(String(vi).replace(/\d[\d.,]*/g, '#'), entry);
});
/* Prefix/regex rules for messages with dynamic tails (checked after exact map) */
const MSG_RULES = [
  [/^Recording error: (.+)$/, 'Lỗi ghi âm: $1', /^Lỗi ghi âm: (.+)$/, 'Recording error: $1'],
  [/^Cannot capture tab: (.+)$/, 'Không thu được tab: $1', /^Không thu được tab: (.+)$/, 'Cannot capture tab: $1'],
  [/^Tab audio failed \((.*)\) — switching to Microphone$/, 'Âm thanh Tab lỗi ($1) — chuyển sang Micro', /^Âm thanh Tab lỗi \((.*)\) — chuyển sang Micro$/, 'Tab audio failed ($1) — switching to Microphone'],
  [/^Compression failed: (.+)$/, 'Nén thất bại: $1', /^Nén thất bại: (.+)$/, 'Compression failed: $1'],
  [/^Auto compress failed:(.*)$/, 'Tự nén thất bại:$1', /^Tự nén thất bại:(.*)$/, 'Auto compress failed:$1'],
  [/^Summarized with (.+) successfully$/, 'Đã tổng kết bằng $1', /^Đã tổng kết bằng (.+)$/, 'Summarized with $1 successfully'],
  [/^Error: (.+)$/, 'Lỗi: $1', /^Lỗi: (.+)$/, 'Error: $1'],
];
/** Passthrough message translator for toasts/statuses — unknown messages unchanged. */
function tt(msg) {
  const s = String(msg ?? '');
  if (!s) return s;
  const toVi = appLang === 'vi';
  const nums = s.match(/\d[\d.,]*/g) || [];
  const norm = s.replace(/\d[\d.,]*/g, '#');
  const hit = MSG_EXACT.get(norm) || MSG_EXACT.get(s);
  if (hit) {
    let out = toVi ? hit.vi : hit.en;
    let i = 0;
    out = out.replace(/#/g, () => (nums[i++] !== undefined ? nums[i - 1] : '#'));
    return out;
  }
  for (const [reEn, viTpl, reVi, enTpl] of MSG_RULES) {
    if (toVi) {
      const m = s.match(reEn);
      if (m) return viTpl.replace(/\$(\d)/g, (_, d) => m[Number(d)] ?? '');
    } else {
      const m = s.match(reVi);
      if (m) return enTpl.replace(/\$(\d)/g, (_, d) => m[Number(d)] ?? '');
    }
  }
  return s;
}
/** Apply interface language to all static strings, then re-render dynamic chrome. Guarded. */
function applyI18n() {
  try {
    document.documentElement.lang = appLang === 'vi' ? 'vi' : 'en';
    document.title = i18nT('app_title');
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = i18nT(el.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = i18nT(el.getAttribute('data-i18n-html')); });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.setAttribute('placeholder', i18nT(el.getAttribute('data-i18n-ph'))); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', i18nT(el.getAttribute('data-i18n-title'))); });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', i18nT(el.getAttribute('data-i18n-aria'))); });
    // Preset prompts follow UI language
    try {
      const prompts = I18N_PROMPTS[appLang] || I18N_PROMPTS.vi;
      document.querySelectorAll('.ctx-preset[data-prompt]').forEach((b, i) => {
        if (prompts[i]) b.setAttribute('data-prompt', prompts[i]);
      });
    } catch {}
    // Lang toggle button shows current language
    try {
      const lb = document.getElementById('langToggleBtn');
      if (lb) {
        lb.textContent = appLang === 'vi' ? 'VI' : 'EN';
        lb.setAttribute('title', i18nT(appLang === 'vi' ? 'lang_btn_title_vi' : 'lang_btn_title_en'));
        lb.setAttribute('aria-label', i18nT(appLang === 'vi' ? 'lang_btn_title_vi' : 'lang_btn_title_en'));
        lb.classList.toggle('lang-vi', appLang === 'vi');
      }
    } catch {}
    // Re-render dynamic chrome in the new language
    try { updateUIForListening(!!isListening); } catch {}
    try { updateMemoryMeter(); } catch {}
    try { updateWordCounts(); } catch {}
    try { updateCompressToggleUI(); } catch {}
    try { updateContextPromptBadge(false); } catch {}
    try { if (typeof lastStatusMsg === 'string') showStatus(lastStatusMsg); } catch {}
    try { updateDock(); } catch {}
    try {
      const se = document.getElementById('suggestEmpty');
      if (se && se.textContent.trim()) se.textContent = i18nT('suggest_empty');
    } catch {}
    // Existing transcript utterances keep old chrome text — refresh in place
    try {
      document.querySelectorAll('.q-flag').forEach((el) => { el.textContent = i18nT('q_flag'); });
      document.querySelectorAll('.utterance-cta').forEach((el) => { el.textContent = i18nT('view_cta'); el.title = i18nT('view_cta_title'); });
      (utteranceDomCache || []).forEach((cache, idx) => {
        if (!cache || !cache.root) return;
        const spk = (cache._speakerId !== undefined) ? cache._speakerId
          : (typeof utteranceSpeakers !== 'undefined' ? utteranceSpeakers[idx] : undefined);
        if (spk !== undefined && typeof applySpeakerToDom === 'function') { try { applySpeakerToDom(cache, spk); } catch {} }
      });
    } catch {}
  } catch (e) { console.warn('[applyI18n]', e); }
}
function setAppLang(lang, persist = true) {
  if (lang !== 'vi' && lang !== 'en') return;
  appLang = lang;
  if (persist) {
    try { localStorage.setItem('app_lang', lang); } catch {}
    try { if (window.chrome && chrome.storage && chrome.storage.local) chrome.storage.local.set({ app_lang: lang }); } catch {}
  }
  applyI18n();
}
/** Header VI/EN toggle — guarded */
function setupLangToggle() {
  try {
    let saved = null;
    try { saved = localStorage.getItem('app_lang'); } catch {}
    if (saved === 'vi' || saved === 'en') appLang = saved;
    try {
      if (window.chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['app_lang'], (r) => {
          if (r && (r.app_lang === 'vi' || r.app_lang === 'en') && r.app_lang !== appLang) setAppLang(r.app_lang, false);
        });
      }
    } catch {}
    const btn = document.getElementById('langToggleBtn');
    if (btn) btn.addEventListener('click', () => setAppLang(appLang === 'vi' ? 'en' : 'vi'));
    applyI18n();
  } catch (e) { console.warn('[setupLangToggle]', e); }
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
  State.fullEnHistory = fullEnHistory;
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

// Provider config state (custom: baseUrl + apiKey + model + thinkingEnabled)
let providerConfig = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: '',
  model: 'gemini-2.5-flash',
  thinkingEnabled: true
};
/** Thinking toggle — ON (default) = current behavior; OFF disables model reasoning/thinking across backends */
function isThinkingEnabledSide(cfg, opts) {
  const v = (opts && opts.thinkingEnabled !== undefined) ? opts.thinkingEnabled : (cfg ? (cfg.thinkingEnabled !== undefined ? cfg.thinkingEnabled : cfg.thinking) : true);
  if (typeof v === 'string') return !/^(off|false|0|disabled|disable|no)$/i.test(v.trim());
  return v !== false && v !== 0;
}
function geminiThinkingOffConfigSide() { return { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } }; }
function openaiThinkingOffParamsSide() {
  return {
    reasoning_effort: 'none',
    reasoning: { effort: 'none', exclude: true },
    thinking: { type: 'disabled' },
    think: false,
    enable_thinking: false,
    chat_template_kwargs: { enable_thinking: false },
  };
}
/** Actionable error for non-OK provider responses (mirror of src friendlyProviderError). 403 from local/Ollama = blocked extension origin. */
function friendlyProviderErrorSide(status, bodyText, baseUrl) {
  let msg = `HTTP ${status}`;
  const t = String(bodyText == null ? '' : bodyText).slice(0, 500);
  if (t) {
    let detail = '';
    try {
      const d = JSON.parse(t);
      const e = d && d.error;
      if (typeof e === 'string') detail = e;
      else if (e && typeof e.message === 'string') detail = e.message;
      else if (e && typeof e.msg === 'string') detail = e.msg;
      else if (e && typeof e === 'object') { try { detail = JSON.stringify(e).slice(0, 300); } catch {} }
      else if (d && typeof d.message === 'string') detail = d.message;
    } catch {
      if (t.length <= 200 && !/^\s*</.test(t)) detail = t;
    }
    detail = String(detail || '').trim().slice(0, 300);
    if (detail) msg += ': ' + detail;
  }
  const url = String(baseUrl || '');
  const isLocalSide = url.includes('localhost') || url.includes('127.0.0.1');
  if (Number(status) === 403 && (isLocalSide || /ollama/i.test(url))) {
    msg += ' — Ollama blocked the extension origin. Restart Ollama with OLLAMA_ORIGINS="chrome-extension://*" (e.g. OLLAMA_ORIGINS="*" ollama serve), then retry.';
  }
  return new Error(msg);
}
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
  tabLive: $id('tabLive'), tabSummary: $id('tabSummary'), tabContext: $id('tabContext'), liveTabContent: $id('liveTabContent'), summaryTabContent: $id('summaryTabContent'), contextTabContent: $id('contextTabContent'),
  settingsBtn: $id('settingsBtn'), settingsOverlay: $id('settingsOverlay'), closeSettingsBtn: $id('closeSettingsBtn'), baseUrlInput: $id('baseUrlInput'), apiKeyInput: $id('apiKeyInput'), toggleApiKeyVisibilityBtn: $id('toggleApiKeyVisibilityBtn'), modelInput: $id('modelInput'), geminiModelSelect: $id('geminiModelSelect'), thinkingToggle: $id('thinkingToggle'), saveSettingsBtn: $id('saveSettingsBtn'),
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
const tabLive = DOM.tabLive; const tabSummary = DOM.tabSummary; const tabContext = DOM.tabContext; const liveTabContent = DOM.liveTabContent; const summaryTabContent = DOM.summaryTabContent; const contextTabContent = DOM.contextTabContent;
const settingsBtn = DOM.settingsBtn; const settingsOverlay = DOM.settingsOverlay; const closeSettingsBtn = DOM.closeSettingsBtn; const baseUrlInput = DOM.baseUrlInput; const apiKeyInput = DOM.apiKeyInput; const toggleApiKeyVisibilityBtn = DOM.toggleApiKeyVisibilityBtn; const modelInput = DOM.modelInput; const geminiModelSelect = DOM.geminiModelSelect; const thinkingToggle = DOM.thinkingToggle; const saveSettingsBtn = DOM.saveSettingsBtn;
const apiWarningCard = DOM.apiWarningCard; const configNowBtn = DOM.configNowBtn; const summaryLangSelect = DOM.summaryLangSelect; const summaryDetailSelect = DOM.summaryDetailSelect; const generateSummaryBtn = DOM.generateSummaryBtn; const copySummaryBtn = DOM.copySummaryBtn; const summaryPlaceholder = DOM.summaryPlaceholder; const summaryMarkdown = DOM.summaryMarkdown; const summaryLoading = DOM.summaryLoading; const summaryContent = DOM.summaryContent;

// --- Pure utils (testable, no side effects) ---
/** Escape HTML — covers &, <, >, ", ', ` */
function escapeHtml(str) { if (!str) return ''; return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/`/g,'&#96;'); }
/** Debounce with cancel */
function debounce(fn, ms) { let t=null; const d=(...a)=>{ if(t) clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; d.cancel=()=>{ if(t) clearTimeout(t); t=null; }; return d; }
/** Promise wrapper for chrome.storage — validated, lastError aware, size capped */
function storageGet(keys) { try { const p = chrome.storage.local.get(keys); if (p && typeof p.then==='function') return p.catch(e=>{console.warn('[storageGet]',e);return {};}); return new Promise((res)=> chrome.storage.local.get(keys, (r)=>{ if(chrome.runtime.lastError){console.warn('[storageGet]',chrome.runtime.lastError.message); res({});} else res(r||{});})); } catch(e){ console.warn('[storageGet]',e); return Promise.resolve({}); } }
function storageSet(obj) { try { if(!obj||typeof obj!=='object') return Promise.resolve(); for(const k of Object.keys(obj)){ const v=obj[k]; if(typeof v==='string'){ const cap = k==='compressedSummary' ? COMPRESSED_SUMMARY_MAX_CHARS + 5000 : 8000; if(v.length>cap) obj[k]=v.slice(-cap); } } const p = chrome.storage.local.set(obj); if (p && typeof p.then==='function') return p.catch(e=>console.warn('[storageSet]',e)); return new Promise((res)=> chrome.storage.local.set(obj, ()=>{ if(chrome.runtime.lastError) console.warn('[storageSet]',chrome.runtime.lastError.message); res();})); } catch(e){ console.warn('[storageSet]',e); return Promise.resolve(); } }
function isValidUrl(s) { try { new URL(s); return true; } catch { return false; } }
function sanitizePromptContext(s) { return String(s||'').trim().slice(0,600).replace(/"""/g,'"\'"').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'').replace(/[ \t]{3,}/g,' ').trim(); }
/** Sanitize LARGE transcript segments (no 600 cap) — same injection protection, keeps tail up to maxChars. Mirror of src/utils/sanitizePromptContext.js sanitizePromptSegment(). */
function sanitizePromptSegmentSide(s, maxChars) { const cap = Math.max(1000, Number(maxChars) || 12000); let t = String(s||'').trim(); if (t.length > cap) t = t.slice(-cap); return t.replace(/"""/g,'"\'"').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'').replace(/[ \t]{3,}/g,' ').trim(); }

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
  if (badge && suggestContextPrompt.trim() && badge.textContent.trim()) badge.textContent = i18nT('saved_badge');
  if (showTemp && suggestContextPrompt.trim()) {
    badge.style.display = 'inline-block'; badge.textContent = i18nT('saved_badge');
    clearTimeout(badge._t); badge._t = setTimeout(() => { badge.style.display = 'none'; }, 1800);
  } else if (!suggestContextPrompt.trim()) badge.style.display = 'none';
}
function setupContextPrompt() {
  const inp = DOM.contextPromptInput; const clearBtn = DOM.clearContextPromptBtn;
  const wrap = DOM.contextPromptWrap || document.getElementById('contextPromptWrap');
  const toggle = DOM.contextPromptToggle || document.getElementById('contextPromptToggle');
  const collapsible = DOM.contextPromptCollapsible || document.getElementById('contextPromptCollapsible');
  if (!inp) return;
  // expanded by default so step 1 shows the hint box immediately
  if (wrap && toggle && collapsible) {
    const setCollapsed = (collapsed) => {
      wrap.classList.toggle('collapsed', collapsed);
      toggle.setAttribute('aria-expanded', String(!collapsed));
      collapsible.hidden = collapsed;
      collapsible.style.display = collapsed ? 'none' : 'flex';
    };
    setCollapsed(false);
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
    setupEventListeners(); setupTabNavigation(); setupKeyboardShortcuts(); setupLiveView(); setupTranscriptSettings(); setupLangToggle();
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
      try { performance.measure('sidepanel-full', 'sidepanel-js-start', 'sidepanel-ready'); } catch {}
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
    if (typeof r[CONFIG.STORAGE_KEYS.compressedSummary] === 'string') compressedSummary = r[CONFIG.STORAGE_KEYS.compressedSummary].slice(-COMPRESSED_SUMMARY_MAX_CHARS);
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
    showToast(compressEnabled ? 'History compression enabled (10m)' : 'History compression disabled', 'default');
    if (compressEnabled) {
      startCompressTimer();
      if (finalizedEnPhrases.length - lastCompressedIdx >= 5) void performCompression(false);
    } else stopCompressTimer();
  });
  const manualBtn = document.getElementById('manualCompressBtn');
  if (manualBtn) manualBtn.addEventListener('click', async () => {
    if (!compressEnabled) { showToast('Enable 10m compression before manual compress', 'default'); return; }
    await performCompression(true); updateCompressToggleUI();
  });
}
/** Pure UI update for compress — no side effects beyond DOM */
function updateCompressToggleUI() {
  const el = document.getElementById('compressToggle'); const badge = document.getElementById('compressBadge'); const statusEl = document.getElementById('compressStatus');
  if (el) el.checked = !!compressEnabled;
  if (badge) {
    if (compressedSummary) { badge.textContent = i18nT('cmp_badge', { n: lastCompressedIdx }); badge.style.display = 'inline-block'; }
    else { badge.textContent = compressEnabled ? i18nT('cmp_badge_waiting') : ''; badge.style.display = compressEnabled ? 'inline-block' : 'none'; }
  }
  if (!statusEl) return;
  const pending = Math.max(0, finalizedEnPhrases.length - lastCompressedIdx);
  if (!compressEnabled) { statusEl.style.display = 'none'; return; }
  statusEl.style.display = 'flex';
  if (compressedSummary) { statusEl.classList.add('has-content'); statusEl.textContent = i18nT('cmp_done', { n: lastCompressedIdx, p: pending, c: compressedSummary.length }); }
  else if (pending > 0) { statusEl.classList.remove('has-content'); statusEl.textContent = i18nT('cmp_pending', { n: pending }); }
  else { statusEl.classList.remove('has-content'); statusEl.textContent = i18nT('cmp_waiting'); }
  const manualBtn = document.getElementById('manualCompressBtn');
  if (manualBtn) { manualBtn.style.display = compressEnabled ? 'inline-block' : 'none'; manualBtn.disabled = !!compressInProgress || pending < 2; manualBtn.title = pending < 2 ? i18nT('cmp_manual_empty') : i18nT('cmp_manual_title', { n: pending }); }
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
    const truncated = ctx.length > MEMORY_BUDGET ? ctx.slice(-MEMORY_BUDGET) : ctx;
    liveCtx = `Conversation history (all ${liveCount} utterances, budget ${MEMORY_BUDGET} chars):\n${truncated || '(empty — speak to fill context)'}`;
  }
  return {
    liveCtx,
    compressedPreview: comp || '(no compressed history yet — enable 🗜️ and wait for 10m or click Compress now)',
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
    try { const g = await checkAndHidePermissionOverlay(); if (g && !isListening) showStatus('Ready'); } catch (e) { console.warn('[focus]', e); }
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

function buildSuggestPrompt(question, contextEn, opts) {
  function truncateForPrompt(arr, maxChars) { const j = arr.join(' | '); return j.length > maxChars ? j.slice(-maxChars) : j; }
  const sanitizedCtx = sanitizePromptContext(suggestContextPrompt);
  const contextHint = sanitizedCtx ? `User-provided context (use to tailor tone/style/domain of answers): """${sanitizedCtx}"""\n\n` : '';
  const quality = opts && opts.quality === 'fast' ? 'fast' : 'quality';
  const isFast = quality === 'fast';
  const wordsSpec = isFast ? '40-70 words' : '60-120 words';
  const sentSpec = isFast ? '2-3 sentences' : '3-5 sentences';
  const maxCtx = isFast ? (CONFIG.SUGGEST_CTX_FAST || 8000) : (CONFIG.SUGGEST_CTX_QUALITY || 12000);
  const recentBudget = isFast ? (CONFIG.SUGGEST_RECENT_FAST || 3000) : (CONFIG.SUGGEST_RECENT_QUALITY || 4000);
  if (compressEnabled && compressedSummary) {
    const recent = contextEn.slice(-COMPRESS_RECENT_KEEP);
    const recentCtx = truncateForPrompt(recent, recentBudget);
    const comp = compressedSummary.length > COMPRESS_MAX_CHARS ? compressedSummary.slice(-COMPRESS_MAX_CHARS) : compressedSummary;
    return `You are a bilingual EN->VI meeting assistant. Generate quick English answers.

${contextHint}History: """${comp}"""
Recent (${recent.length}): """${recentCtx}"""
Q: """${question}"""

Return JSON ONLY: {"structures":["3-7 words hint x3"],"answers":["${sentSpec}, ${wordsSpec} paragraph x3, diverse tones, conversational"]}
Rules: 3 structures + 3 answers, consistent with history${contextHint ? '+context' : ''}, placeholder [City, Country] if location Q. No markdown.`;
  }
  const ctx = truncateForPrompt(contextEn, maxCtx);
  return `You are a bilingual EN->VI meeting assistant. Generate quick English answers.

${contextHint}History: """${ctx}"""
Q: """${question}"""

Return JSON ONLY: {"structures":["3-7 words hint x3"],"answers":["${sentSpec}, ${wordsSpec} paragraph x3, diverse tones, conversational"]}
Rules: 3 structures + 3 answers, consistent with history. No markdown.`;
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
async function callProviderForSuggest(prompt, opts) {
  opts = opts || {};
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) throw new Error('Empty prompt');
  const baseUrl = providerConfig.baseUrl.replace(/\/+$/, '');
  const model = providerConfig.model;
  const apiKey = providerConfig.apiKey;
  const isLocal = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');
  const isGemini = baseUrl.includes('generativelanguage.googleapis.com');
  const isOllama = /ollama/i.test(baseUrl) || /ollama/i.test(model);
  function geminiEmptyReasonSide(data) {
    const cand = data && data.candidates && data.candidates[0];
    if (!cand) {
      const block = data && data.promptFeedback && data.promptFeedback.blockReason;
      if (block) return 'Blocked by Gemini: ' + block;
      return 'Empty LLM response';
    }
    const fr = cand.finishReason;
    if (fr && fr !== 'STOP' && fr !== 'stop') {
      if (fr === 'SAFETY') return 'Empty LLM response (blocked by safety filter)';
      if (fr === 'RECITATION') return 'Empty LLM response (recitation block)';
      if (fr === 'MAX_TOKENS') return 'Empty LLM response (max tokens reached)';
      return 'Empty LLM response (finishReason: ' + fr + ')';
    }
    return 'Empty LLM response';
  }
  function shortenPromptForRetrySide(p) {
    return String(p).replace(/60-120 words/g, '30-60 words').replace(/3-5 sentences/g, '2-3 sentences');
  }
  const thinkingOn = isThinkingEnabledSide(providerConfig, opts);
  const geminiThinkOff = thinkingOn ? {} : geminiThinkingOffConfigSide();
  const openaiThinkOff = thinkingOn ? {} : openaiThinkingOffParamsSide();
  function geminiJsonConfig(max) { return { temperature: 0.8, maxOutputTokens: max, responseMimeType: 'application/json', ...geminiThinkOff }; }
  let curMax = isGemini ? (opts.quality === 'fast' ? 512 : 1024) : isOllama ? (opts.quality === 'fast' ? 384 : 700) : (opts.quality === 'fast' ? 512 : 1024);
  let curPrompt = prompt;
  if (isGemini) {
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
    // streaming fast-path
    if (opts.onChunk && !isLocal) {
      try {
        const streamUrl = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}&alt=sse`;
        const sRes = await fetch(streamUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: curPrompt }] }], generationConfig: geminiJsonConfig(curMax) }) });
        if (sRes.ok && sRes.body && sRes.body.getReader) {
          const reader = sRes.body.getReader(); const dec = new TextDecoder(); let acc=''; let buf='';
          while (true) { const {done,value}=await reader.read(); if(done) break; buf+=dec.decode(value,{stream:true}); const lines=buf.split('\n'); buf=lines.pop()||''; for(const line of lines){ const t=line.trim(); if(!t.startsWith('data:')) continue; const p=t.slice(5).trim(); if(!p||p==='[DONE]') continue; try{ const j=JSON.parse(p); const ch=j.candidates?.[0]?.content?.parts?.[0]?.text||''; if(ch){acc+=ch; try{opts.onChunk(acc);}catch{}}}catch{}} }
          if (acc && acc.trim()) return acc;
        }
      } catch(e){ console.warn('[provider] Gemini stream fallback', e.message); }
    }
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchWithRetrySidepanel(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: curPrompt }] }], generationConfig: geminiJsonConfig(curMax) })
      }, 20000, 1);
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw friendlyProviderErrorSide(res.status, bodyText, baseUrl);
      }
      const data = await res.json();
      const txt = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (txt && txt.trim()) return txt;
      const reason = geminiEmptyReasonSide(data);
      console.warn(`[provider] Gemini attempt ${attempt+1} empty: ${reason} (prompt ${curPrompt.length} chars, max ${curMax})`, data);
      lastErr = new Error(reason);
      if (reason.includes('max tokens') || reason.includes('MAX_TOKENS')) { curMax = 1800; curPrompt = shortenPromptForRetrySide(curPrompt); }
      if (attempt === 0) await new Promise(r => setTimeout(r, 600));
    }
    throw lastErr;
  } else {
    const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (opts.onChunk && !isLocal && !isOllama) {
      try {
        const sRes = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'system', content: 'You output ONLY JSON object with "structures" and "answers" arrays. No markdown, no extra text.' },{ role: 'user', content: curPrompt }], temperature: 0.85, max_tokens: curMax, stream: true, response_format: { type: 'json_object' }, ...openaiThinkOff }) });
        if (sRes.ok && sRes.body && sRes.body.getReader) {
          const reader=sRes.body.getReader(); const dec=new TextDecoder(); let acc=''; let buf='';
          while(true){ const {done,value}=await reader.read(); if(done) break; buf+=dec.decode(value,{stream:true}); const lines=buf.split('\n'); buf=lines.pop()||''; for(const line of lines){ const t=line.trim(); if(!t.startsWith('data:')) continue; const p=t.slice(5).trim(); if(!p||p==='[DONE]') continue; try{ const j=JSON.parse(p); const d=j.choices?.[0]?.delta?.content||j.choices?.[0]?.message?.content||''; if(d){acc+=d; try{opts.onChunk(acc);}catch{}}}catch{}} }
          if(acc && acc.trim()) return acc;
        }
      } catch(e){ console.warn('[provider] OpenAI stream fallback', e.message); }
    }
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const payload = { model, messages: [{ role: 'system', content: 'You output ONLY JSON object with "structures" and "answers" arrays. No markdown, no extra text.' },{ role: 'user', content: curPrompt }], temperature: isOllama ? 0.7 : 0.85, max_tokens: curMax, ...(isOllama ? {} : { response_format: { type: 'json_object' } }), ...openaiThinkOff };
      let res = await fetchWithRetrySidepanel(url, { method: 'POST', headers, body: JSON.stringify(payload) }, 20000, 1);
      if (!res.ok && res.status === 400 && !isOllama) { try{await res.text();}catch{} delete payload.response_format; res = await fetchWithRetrySidepanel(url, { method: 'POST', headers, body: JSON.stringify(payload) }, 20000, 0); }
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw friendlyProviderErrorSide(res.status, bodyText, baseUrl);
      }
      const data = await res.json();
      let txt = data.choices?.[0]?.message?.content || '';
      if (!txt && data.message?.content) txt = data.message.content;
      if (!txt && typeof data.response === 'string') txt = data.response;
      if (txt && txt.trim()) return txt;
      const finish = data.choices?.[0]?.finish_reason;
      const usage = data.usage;
      console.warn(`[provider] OpenAI attempt ${attempt+1} empty: finish=${finish} usage=${JSON.stringify(usage)} prompt ${curPrompt.length} chars max ${curMax}`, data);
      lastErr = new Error(finish === 'content_filter' ? 'Empty LLM response (content filter)' : finish === 'length' ? 'Empty LLM response (max tokens / length)' : 'Empty LLM response');
      if (finish === 'length') { curMax = 1800; curPrompt = shortenPromptForRetrySide(curPrompt); }
      if (attempt === 0) await new Promise(r => setTimeout(r, 600));
    }
    throw lastErr;
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
  const thinkingOnGeneric = isThinkingEnabledSide(providerConfig, opts);
  const geminiThinkOffGeneric = thinkingOnGeneric ? {} : geminiThinkingOffConfigSide();
  const openaiThinkOffGeneric = thinkingOnGeneric ? {} : openaiThinkingOffParamsSide();
  if (isGemini) {
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const res = await fetchWithRetrySidepanel(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }] }], generationConfig: { temperature, maxOutputTokens: maxTokens, ...geminiThinkOffGeneric } })
    }, 18000, 1);
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw friendlyProviderErrorSide(res.status, bodyText, baseUrl);
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
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, ...openaiThinkOffGeneric })
    }, 18000, 1);
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw friendlyProviderErrorSide(res.status, bodyText, baseUrl);
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
  if (segment.length > COMPRESS_SEGMENT_MAX_CHARS) segment = segment.slice(-COMPRESS_SEGMENT_MAX_CHARS);
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
      const existing = existingSummary ? `\nExisting compressed history (keep continuity, don't duplicate):\n"""${sanitizePromptSegmentSide(existingSummary, 2000)}"""` : '';
      const safeSeg = sanitizePromptSegmentSide(seg, COMPRESS_SEGMENT_MAX_CHARS);
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
      const prompt = `Summarize this conversation segment concisely. Keep key facts, names, topics, questions, decisions, and any context needed to answer future questions. Output 3-5 bullet points, max 150 words, in English. No extra intro.\n\nSegment:\n"""${sanitizePromptSegmentSide(segment, COMPRESS_SEGMENT_MAX_CHARS)}"""`;
      summary = await callProviderGeneric(prompt, { temperature: 0.3, maxTokens: 300, systemPrompt: 'You are a concise meeting summarizer. Output only bullet points.' });
      if (!_isValidCompressSummary(summary)) throw new Error('Fallback summary invalid');
    }
    const clean = String(summary||'').trim();
    if (!clean) { if (isManual) showToast('Compression returned empty','error'); return; }
    const header = `\n[+${pendingCount} utterances @ ${new Date().toLocaleTimeString()}]`;
    compressedSummary = (compressedSummary ? compressedSummary + header + '\n' : '') + clean;
    if (compressedSummary.length > COMPRESSED_SUMMARY_MAX_CHARS) compressedSummary = compressedSummary.slice(-COMPRESSED_SUMMARY_MAX_CHARS);
    lastCompressedIdx = finalizedEnPhrases.length;
    try { await storageSet({ compressedSummary, lastCompressedIdx }); } catch {}
    syncState();
    updateCompressToggleUI();
    if (isManual) showToast(`Compressed ${pendingCount} sentences`, 'success');
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

/**
 * Quick replies = câu trả lời thẳng, ngắn gọn (câu đầu của mỗi complete
 * answer, tối đa ~140 ký tự). Fallback về structures khi chưa có answers.
 * Mirror: src/utils/quickReplies.js
 * @param {string[]} answers
 * @param {string[]} structures
 * @returns {string[]}
 */
function firstSentenceDirect(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const m = t.match(/^[^.!?]+[.!?]/);
  const s = (m ? m[0] : t).trim();
  return s.length > 140 ? s.slice(0, 140).trimEnd() + '…' : s;
}
function makeQuickReplies(answers, structures) {
  const out = (Array.isArray(answers) ? answers : [])
    .map(firstSentenceDirect)
    .filter((s) => s && s.length >= 8);
  if (out.length > 0) return out.slice(0, 3);
  return (Array.isArray(structures) ? structures : []).slice(0, 3);
}

function hashForSuggestSide(q, tail) { const n = String(q||'').trim().toLowerCase().replace(/\s+/g,' ').slice(0,160); const t = String(tail||'').slice(-300).toLowerCase(); return n+'|'+t; }
async function triggerSuggestForIndex(idx, question) {
  if (!suggestEnabled) return;
  const isLocal = providerConfig.baseUrl.includes('localhost') || providerConfig.baseUrl.includes('127.0.0.1');
  if (!providerConfig.baseUrl || !providerConfig.model || (!providerConfig.apiKey && !isLocal)) {
    questionSuggestions[idx] = { ...(questionSuggestions[idx] && questionSuggestions[idx].answered ? { answered: true } : {}), state: 'error', question, answers: [], structures: [], error: 'AI Provider not configured' };
    updateSuggestCard(idx);
    updateDock();
    return;
  }
  const contextSlice = compressEnabled
    ? finalizedEnPhrases.slice(Math.max(0, idx - COMPRESS_RECENT_KEEP + 1), idx + 1)
    : finalizedEnPhrases.slice(0, idx + 1);
  const ctxTail = contextSlice.slice(-4).join('|').slice(-300);
  const hash = hashForSuggestSide(question, ctxTail + (suggestContextPrompt||'').slice(-100));
  // cache hit — instant (0ms)
  const cached = State.suggestCache.get(hash);
  if (cached && Date.now() - cached.ts < 10*60*1000) {
    questionSuggestions[idx] = { ...(questionSuggestions[idx] && questionSuggestions[idx].answered ? { answered: true } : {}), state: 'done', question, answers: cached.data.answers.slice(), structures: cached.data.structures.slice() };
    selectedQuestionIdx = idx; updateSuggestCard(idx); updateDock(); return;
  }
  const inflight = State.suggestInFlight.get(hash);
  if (inflight) {
    questionSuggestions[idx] = { ...(questionSuggestions[idx] && questionSuggestions[idx].answered ? { answered: true } : {}), state: 'loading', question, answers: [], structures: [] };
    selectedQuestionIdx = idx; updateSuggestCard(idx); updateDock();
    try { const r = await inflight; questionSuggestions[idx] = { ...(questionSuggestions[idx] && questionSuggestions[idx].answered ? { answered: true } : {}), state: 'done', question, answers: r.answers.slice(), structures: r.structures.slice() }; } catch(e){ questionSuggestions[idx] = { ...(questionSuggestions[idx] && questionSuggestions[idx].answered ? { answered: true } : {}), state: 'error', question, answers: [], structures: [], error: e.message||'AI error'}; }
    updateSuggestCard(idx); updateDock(); autoScroll(true); return;
  }
  // parallel: display loading immediately, then fetch concurrently (no serial queue)
  questionSuggestions[idx] = { ...(questionSuggestions[idx] && questionSuggestions[idx].answered ? { answered: true } : {}), state: 'loading', question, answers: [], structures: [] };
  // auto-select latest question for pills bar
  selectedQuestionIdx = idx;
  updateSuggestCard(idx);
  updateDock();
  // fire async without awaiting queue — with streaming + dedup
  const promise = (async () => {
    try {
      // fast quality first for low latency (~2-3s perceived via streaming), fallback to quality is not needed
      const prompt = buildSuggestPrompt(question, contextSlice, { quality: 'fast' });
      let streamingShown = false;
      const onChunk = (acc) => {
        if (streamingShown) return;
        try {
          const p = parseSuggestAnswers(acc);
          if ((p.answers && p.answers.length) || (p.structures && p.structures.length)) {
            // show partial instantly
            const partial = { state: 'done', question, answers: p.answers.slice(0,3), structures: p.structures.slice(0,3) };
            if (partial.answers.length || partial.structures.length) {
              if (questionSuggestions[idx] && questionSuggestions[idx].answered) partial.answered = true;
              questionSuggestions[idx] = partial;
              updateSuggestCard(idx); updateDock();
              streamingShown = true;
            }
          }
        } catch {}
      };
      const raw = await callProviderForSuggest(prompt, { onChunk });
      const parsed = parseSuggestAnswers(raw);
      let { structures, answers } = parsed;
      answers = answers.filter(a => !(a.trim().startsWith('{') && /"structures"|"answers"/.test(a)));
      structures = structures.filter(s => !(s.trim().startsWith('{') && /"structures"|"answers"/.test(s)));
      answers = answers.filter(a => !(a.includes(' + ') && a.split(/\s+/).length < 15));
      // relax: vague Q like "can you figure out why" legitimately returns short answers — don't nuke them
      const isSubstantial = (a) => a.length >= 25 && a.split(/\s+/).length >= 5;
      const substantialAnswers = answers.filter(isSubstantial);
      if (substantialAnswers.length > 0) answers = substantialAnswers;
      else if (answers.length > 0 && answers.every(a => a.length < 25 && a.split(/\s+/).length < 5)) {
        // keep original instead of wiping — short is better than "Failed to parse"
      }
      if (answers.length === 0 && structures.length === 0) {
        // salvage raw: never leave user with "Failed to parse" when LLM did return text
        if (raw && raw.trim().length >= 10) {
          answers = [raw.trim().slice(0, 400)];
        } else throw new Error('Failed to parse suggestions');
      }
      if (structures.length === 0 && answers.length > 0) structures = synthesizeStructures(answers);
      answers = answers.slice(0,3);
      structures = structures.slice(0,3);
      const result = { answers, structures };
      State.suggestCache.set(hash, { data: result, ts: Date.now() });
      if (State.suggestCache.size > 80) { const first = State.suggestCache.keys().next().value; State.suggestCache.delete(first); }
      questionSuggestions[idx] = { ...(questionSuggestions[idx] && questionSuggestions[idx].answered ? { answered: true } : {}), state: 'done', question, answers, structures };
      return result;
    } catch (e) {
      questionSuggestions[idx] = { ...(questionSuggestions[idx] && questionSuggestions[idx].answered ? { answered: true } : {}), state: 'error', question, answers: [], structures: [], error: e.message || 'AI error' };
      throw e;
    } finally {
      updateSuggestCard(idx);
      updateDock();
      autoScroll(true);
      State.suggestInFlight.delete(hash);
    }
  })();
  State.suggestInFlight.set(hash, promise);
  promise.catch(()=>{});
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
  if (qCountBadge) qCountBadge.textContent = i18nT('q_count', { n: count });
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
      const isDone = !!(data && data.answered);
      pill.className = 'q-pill' + (Number(idx)===selectedQuestionIdx ? ' active' : '') + (isDone ? ' qpill-done' : '');
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
    suggestionBody.innerHTML = '<div class="suggest-empty" id="suggestEmpty">' + escapeHtml(i18nT('suggest_empty')) + '</div>';
    return;
  }
  if (selectedQuestionIdx === null || !questionSuggestions[selectedQuestionIdx]) {
    suggestionBody.innerHTML = '<div class="suggest-empty">' + escapeHtml(i18nT('select_q')) + '</div>';
    return;
  }
  const data = questionSuggestions[selectedQuestionIdx];
  if (data.state === 'loading') {
    suggestionBody.innerHTML = `<div class="suggest-loading" style="padding:12px;display:flex;gap:8px;align-items:center;color:var(--text-2);font-size:12px"><div class="spinner" style="width:14px;height:14px;border-width:2px"></div> ${escapeHtml(i18nT('generating_for'))} <em>${escapeHtml(data.question||'')}</em></div>`;
    return;
  }
  if (data.state === 'error') {
    const err = escapeHtml(data.error || 'AI error');
    const idxVal = String(selectedQuestionIdx);
    suggestionBody.innerHTML = `<div class="suggest-error">⚠️ ${err} <button class="retry-suggest-btn" data-retry-idx="${idxVal}" style="margin-left:8px;padding:4px 10px;border-radius:6px;border:1px solid var(--border);cursor:pointer">${escapeHtml(i18nT('retry_btn'))}</button></div>`;
    const retryBtn = suggestionBody.querySelector('[data-retry-idx]');
    if (retryBtn) retryBtn.addEventListener('click', () => {
      const rIdx = Number(retryBtn.getAttribute('data-retry-idx'));
      const q = questionSuggestions[rIdx]?.question || data.question;
      if (Number.isFinite(rIdx) && q) triggerSuggestForIndex(rIdx, q);
    });
    return;
  }
  // done — color-zoned layout ported from React SuggestedAnswersView:
  // 🟧 question / 🟦 quick replies (structures) / 🟩 complete answers (tones) + talking points + answered + TTS
  const showStructure = suggestView==='both' || suggestView==='structure';
  const showComplete = suggestView==='both' || suggestView==='complete';
  const TONES = [i18nT('tone_confident'), i18nT('tone_pro'), i18nT('tone_concise')];
  const toneClass = (tone) => tone === i18nT('tone_confident') ? 'tone-confident' : (tone === i18nT('tone_pro') ? 'tone-pro' : 'tone-concise');
  const qText = data.question || finalizedEnPhrases[selectedQuestionIdx] || '';
  const qVi = finalizedViPhrases[selectedQuestionIdx] || '';
  const isDone = !!data.answered;
  let html = '';
  // 🟧 Question zone
  html += `<div class="dock-q-zone">`
    + `<div class="dock-q-title">${escapeHtml(i18nT(isDone ? 'q_zone_done' : 'q_zone_need', { n: Number(selectedQuestionIdx)+1 }))}</div>`
    + `<div class="dock-q-text">${escapeHtml(qText)}</div>`
    + (qVi && qVi !== '…' ? `<div class="dock-q-vi">${escapeHtml(i18nT('trans_label'))}: ${escapeHtml(qVi)}</div>` : '')
    + `<button class="answered-toggle${isDone ? ' done' : ''}" data-act="toggle-answered" data-idx="${selectedQuestionIdx}">${escapeHtml(i18nT(isDone ? 'marked_done' : 'mark_said'))}</button>`
    + `<button class="mini-act" data-act="speak-q" data-idx="${selectedQuestionIdx}" title="${escapeHtml(i18nT('speak_title'))}">${escapeHtml(i18nT('speak_q'))}</button>`
    + `</div>`;
  html += `</div>`;
  // Quick = câu trả lời thẳng, ngắn gọn (không phải keywords/ideas)
  const structures0 = data.structures && data.structures.length ? data.structures : synthesizeStructures(data.answers);
  if (showStructure) {
    const quicks = makeQuickReplies(data.answers, structures0);
    html += `<div class="dock-quick-label">${escapeHtml(i18nT('quick_label'))}</div>`;
    html += `<div class="dock-structure-list">` + quicks.map((s,i)=>`
      <div class="dock-structure-item">
        <span class="idx">${i+1}.</span>
        <span class="txt">${escapeHtml(s)}</span>
        <span class="dock-structure-actions"><button class="mini-act" data-act="speak" data-text="${escapeHtml(s).replace(/"/g,'&quot;')}" title="Speak">🔊</button><button class="suggest-copy mini-act" data-text="${escapeHtml(s).replace(/"/g,'&quot;')}" title="Copy">⎘</button></span>
      </div>
    `).join('') + `</div>`;
  }
  if (showComplete) {
    if (data.answers && data.answers.length > 0) {
      html += `<div class="dock-complete-label">${escapeHtml(i18nT('complete_label'))}</div>`;
      html += data.answers.map((a,i)=>{
        const tone = TONES[i % TONES.length];
        return `<div class="dock-complete-card">`
        + `<div class="dock-complete-top"><span class="tone-badge ${toneClass(tone)}">${escapeHtml(tone)}</span>`
        + `<span class="dock-complete-actions"><button class="mini-act" data-act="speak" data-text="${escapeHtml(a).replace(/"/g,'&quot;')}" title="${escapeHtml(i18nT('speak_this_title'))}">${escapeHtml(i18nT('speak_this'))}</button>`
        + `<button class="copy-btn mini-act" data-text="${escapeHtml(a).replace(/"/g,'&quot;')}">Copy</button></span></div>`
        + `<div class="answer-text">${escapeHtml(a)}</div>`
        + `</div>`;
      }).join('');
    } else if (showStructure) {
      // no complete answers, but structures shown — don't show empty label
    } else {
      html += `<div class="suggest-empty">${escapeHtml(i18nT('no_complete'))}</div>`;
    }
  }
  suggestionBody.innerHTML = html;
  suggestionBody.querySelectorAll('[data-text]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const act = btn.getAttribute('data-act');
      if (act === 'speak') {
        const txt = btn.getAttribute('data-text') || '';
        if (txt) { try { speakTextPorted(txt, 'en-US'); } catch {} }
        return;
      }
      const txt = btn.getAttribute('data-text');
      if (txt) { try { await navigator.clipboard.writeText(txt); showToast('Copied','success'); } catch { showToast('Copy failed','error'); } }
    });
  });
  suggestionBody.querySelectorAll('[data-act="toggle-answered"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const rIdx = Number(btn.getAttribute('data-idx'));
      if (questionSuggestions[rIdx]) {
        questionSuggestions[rIdx].answered = !questionSuggestions[rIdx].answered;
        syncState();
        updateDock();
      }
    });
  });
  suggestionBody.querySelectorAll('[data-act="speak-q"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const rIdx = Number(btn.getAttribute('data-idx'));
      const txt = (questionSuggestions[rIdx] && questionSuggestions[rIdx].question) || finalizedEnPhrases[rIdx] || '';
      if (txt) { try { speakTextPorted(txt, 'en-US'); } catch {} }
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
/**
 * Strip STT carry-repeat: Chrome Speech often re-emits the last char of the
 * previous final at the start of the next final:
 *   "...my mum did" -> "d I haven't..." / "...Simkins" -> "s how is..."
 * Only strips a single consonant (never "a"/"I") matching the previous tail.
 * Mirror: src/utils/stripSttCarryRepeat.js
 * @param {string} text
 * @param {string} prevText
 * @returns {string}
 */
function stripSttCarryRepeat(text, prevText) {
  const clean = String(text || '').trim();
  if (!clean) return clean;
  const prevTail = String(prevText || '').trim().replace(/[.!?…\s]+$/g, '');
  if (!prevTail) return clean;
  const lastWord = prevTail.split(/\s+/).pop() || '';
  const tailCh = lastWord.slice(-1).toLowerCase();
  // Bare single consonant ("d" after "...did"): whole utterance is the carry
  // fragment — strip to empty so finalizeText() skips it.
  if (/^[A-Za-z]$/.test(clean)) {
    const ch0 = clean.toLowerCase();
    if ((ch0 === 'a' || ch0 === 'i') || !/[b-z]/.test(ch0)) return clean;
    return tailCh === ch0 ? '' : clean;
  }
  const m = clean.match(/^([A-Za-z])(?:(\s+)|(?=[A-Z]))(.*)$/s);
  if (!m) return clean;
  const ch = m[1].toLowerCase();
  if (ch === 'a' || ch === 'i') return clean; // valid English words
  if (!/[b-z]/.test(ch)) return clean;
  // Glued lowercase ("donald...") is a real word, not a fragment — only the
  // spaced form ("d ...") or glued-UPPERCASE ("dI ...") can be carry-repeat.
  if (!m[2] && m[3] && /^[a-z]/.test(m[3])) return clean;
  const rest = (m[3] || '').trim();
  if (tailCh === ch) return rest;
  return clean;
}

/** Last non-empty finalized EN phrase (skips live-slot '' placeholder). */
function prevFinalizedTail() {
  for (let i = finalizedEnPhrases.length - 1; i >= 0; i--) {
    const t = String(finalizedEnPhrases[i] || '').trim();
    if (t) return t;
  }
  return '';
}

async function finalizeText(text) {
  let cleanText = stripSttCarryRepeat(text, prevFinalizedTail()).trim();
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
        // keep the summary archive in sync: drop the archived copy so the
        // merged `combined` text (tracked below) replaces it instead of duplicating
        if (removedEn && fullEnHistory.length > 0 && fullEnHistory[fullEnHistory.length - 1] === removedEn) {
          fullEnHistory.pop();
          syncState();
        }
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
  // Archive for AI summary (append-only — survives compactTranscriptMemory)
  trackFullHistory(utterances);
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
    // Archive for AI summary (live slot's '' placeholder was never tracked)
    trackFullHistory(en);
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
    // Live slots are built with '' so flag + "Xem gợi ý" CTA must be added here
    reconcileQuestionDom(lastCache);
    return true;
  }
  return false;
}

// Fallback providers — mirror of src/services/translate/providers.js (sidepanel runtime copy)
const MYMEMORY_ENDPOINT_SIDE = 'https://api.mymemory.translated.net/get';
const LINGVA_ENDPOINTS_SIDE = ['https://lingva.ml/api/v1/en/vi', 'https://lingva.thedaviddelta.com/api/v1/en/vi'];
function fetchWithTimeoutSide(url, { signal, timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs);
  let onAbort = null;
  if (signal) {
    if (signal.aborted) { clearTimeout(t); return Promise.reject(new DOMException('Aborted', 'AbortError')); }
    onAbort = () => { try { ctrl.abort(); } catch {} };
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return fetch(url, { signal: ctrl.signal }).finally(() => {
    clearTimeout(t);
    if (signal && onAbort) try { signal.removeEventListener('abort', onAbort); } catch {}
  });
}
function chunkForMyMemorySide(text, maxLen) {
  const s = String(text || '');
  maxLen = maxLen || CONFIG.MYMEMORY_MAX_CHARS || 450;
  if (s.length <= maxLen) return [s];
  const parts = s.split(/(?<=[.!?])\s+/);
  const chunks = []; let cur = '';
  for (const p of parts) {
    if ((cur + ' ' + p).trim().length > maxLen) {
      if (cur) chunks.push(cur.trim());
      if (p.length > maxLen) { for (let i = 0; i < p.length; i += maxLen) chunks.push(p.slice(i, i + maxLen)); cur = ''; }
      else cur = p;
    } else cur = cur ? `${cur} ${p}` : p;
  }
  if (cur) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}
async function translateViaMyMemorySide(text, opts = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed || opts.signal?.aborted) return '';
  const chunks = chunkForMyMemorySide(trimmed);
  const outs = [];
  for (const c of chunks) {
    if (opts.signal?.aborted) return '';
    let res;
    try { res = await fetchWithTimeoutSide(`${MYMEMORY_ENDPOINT_SIDE}?q=${encodeURIComponent(c)}&langpair=en|vi`, { signal: opts.signal, timeoutMs: CONFIG.TRANSLATE_FALLBACK_TIMEOUT_MS }); }
    catch (e) { if (e?.name === 'AbortError') return ''; return ''; }
    if (!res?.ok) return '';
    let data; try { data = await res.json(); } catch { return ''; }
    const t = String(data?.responseData?.translatedText || '').trim();
    if (/MYMEMORY WARNING/i.test(t)) return '';
    if (!t) return '';
    if (t.toLowerCase() === c.toLowerCase() && c.length > 15) return '';
    outs.push(t);
  }
  return outs.join(' ').trim();
}
async function translateViaLingvaSide(text, opts = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.length > 2000 || opts.signal?.aborted) return '';
  for (const base of LINGVA_ENDPOINTS_SIDE) {
    if (opts.signal?.aborted) return '';
    let res;
    try { res = await fetchWithTimeoutSide(`${base.replace(/\/+$/, '')}/${encodeURIComponent(trimmed)}`, { signal: opts.signal, timeoutMs: CONFIG.TRANSLATE_FALLBACK_TIMEOUT_MS }); }
    catch (e) { if (e?.name === 'AbortError') return ''; continue; }
    if (!res?.ok) continue;
    try { const data = await res.json(); const out = String(data?.translation || '').trim(); if (out) return out; } catch {}
  }
  return '';
}
function isValidAiProviderConfigSide(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const base = String(cfg.baseUrl || '').trim(); const model = String(cfg.model || '').trim();
  if (!/^https?:\/\/.+/.test(base) || !model) return false;
  const isLocal = base.includes('localhost') || base.includes('127.0.0.1');
  if (!cfg.apiKey && !isLocal) return false;
  return true;
}
async function translateViaAISide(text, opts = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed || opts.signal?.aborted) return '';
  if (!isValidAiProviderConfigSide(providerConfig)) return '';
  try {
    const raw = await callProviderGeneric(`Translate the following English text to Vietnamese. Output ONLY the Vietnamese translation, no explanation, no quotes, no romanization.\n\nEnglish: ${trimmed}`, { temperature: 0.1, maxTokens: 512, systemPrompt: 'You are a precise English to Vietnamese translator. Return only the translation.' });
    const out = String(raw || '').trim().replace(/^["'“”`]+|["'“”`]+$/g, '').trim();
    if (!out) return '';
    if (out.toLowerCase() === trimmed.toLowerCase() && trimmed.length > 15) return '';
    return out;
  } catch (e) { if (e?.name === 'AbortError') return ''; return ''; }
}
async function translateWithFallbackChainSide(text, opts = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { text: '', via: 'none' };
  if (opts.signal?.aborted) return { text: '', via: 'aborted' };
  const order = ['mymemory', 'lingva', 'ai'];
  for (const name of order) {
    if (opts.signal?.aborted) return { text: '', via: 'aborted' };
    if (name === 'ai' && opts.disableAI) continue;
    let out = '';
    if (name === 'mymemory') out = await translateViaMyMemorySide(trimmed, opts);
    else if (name === 'lingva') out = await translateViaLingvaSide(trimmed, opts);
    else if (name === 'ai') out = await translateViaAISide(trimmed, opts);
    if (out) return { text: out, via: name };
  }
  return { text: '', via: 'failed' };
}

// Translate Text via Google Translate free API — cache + chunking + retry + LRU
// + fallback chain MyMemory -> Lingva -> AI (mirror src/services/translate/translate.js)
async function translateText(text, opts = {}) {
  if (!text || !String(text).trim()) return '';
  const trimmed = String(text).trim();
  if (translationCache.has(trimmed)) {
    const cached = translationCache.get(trimmed);
    translationCache.delete(trimmed); translationCache.set(trimmed, cached);
    return cached;
  }
  const googleOut = await translateViaGoogleSide(trimmed, opts);
  if (googleOut) return googleOut;
  if (opts.signal?.aborted) return '';
  if (opts.fallback === false || CONFIG.TRANSLATE_FALLBACK_ENABLED === false) return '';
  try {
    const { text: fb, via } = await translateWithFallbackChainSide(trimmed, opts);
    if (fb) {
      translationCache.set(trimmed, fb);
      if (translationCache.size > TRANSLATION_CACHE_MAX) translationCache.delete(translationCache.keys().next().value);
      console.warn(`[translate] fallback via ${via}:`, trimmed.slice(0, 60));
      return fb;
    }
  } catch {}
  return '';
}
async function translateViaGoogleSide(text, opts = {}) {
  if (!text || !String(text).trim()) return '';
  const trimmed = String(text).trim();
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
  // Update visible speaker badge (ported from React TranscriptView)
  const badge = cache.root.querySelector('.speaker-badge');
  if (badge) {
    const isQ = cache.root.classList.contains('question');
    badge.textContent = isQ ? i18nT('speaker_q') : (speakerId % 2 === 1 ? i18nT('speaker_b') : i18nT('speaker_a'));
  }
}

/** "⚡ Xem gợi ý" button — jumps to Answers view + selects the question.
 * Reads the live dataset.index at click time (survives re-index/compaction). */
function buildQuestionCta() {
  const cta = document.createElement('button');
  cta.className = 'utterance-cta';
  cta.type = 'button';
  cta.textContent = i18nT('view_cta');
  cta.title = i18nT('view_cta_title');
  cta.addEventListener('click', () => {
    try {
      const root = cta.closest('.utterance');
      const curIdx = root ? Number(root.dataset.index) : NaN;
      if (Number.isFinite(curIdx)) selectedQuestionIdx = curIdx;
      if (typeof setLiveView === 'function') setLiveView('answers');
      else if (typeof updateDock === 'function') updateDock();
      const dock = document.getElementById('suggestionDock');
      if (dock && dock.scrollIntoView) dock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch {}
  });
  return cta;
}

/**
 * Reconcile flag + CTA with the current EN text. Live slots are built with ''
 * so promoted questions otherwise never get the button/flag.
 */
function reconcileQuestionDom(cache) {
  if (!cache || !cache.root) return;
  const raw = cache.enText && cache.enText.textContent ? cache.enText.textContent : '';
  const isQ = !!raw.trim() && isQuestion(raw);
  cache.root.classList.toggle('question', isQ);
  const meta = cache.root.querySelector('.utterance-meta');
  if (!meta) return;
  let flag = meta.querySelector('.q-flag');
  let cta = meta.querySelector('.utterance-cta');
  if (isQ) {
    if (!flag) {
      flag = document.createElement('span');
      flag.className = 'q-flag';
      flag.textContent = i18nT('q_flag');
      meta.appendChild(flag);
    }
    if (!cta) meta.appendChild(buildQuestionCta());
    else { cta.textContent = i18nT('view_cta'); cta.title = i18nT('view_cta_title'); }
  } else {
    if (flag) flag.remove();
    if (cta) cta.remove();
  }
}

// Build the DOM for an utterance (shared by appendUtterance and live slot)
function buildUtteranceDom(idx, en, vi) {
  const isQ = isQuestion(en);
  const qMark = isQ ? ' <span class="question-mark">?</span>' : '';

  // Build the utterance DOM node
  const root = document.createElement('div');
  root.className = 'utterance' + (isQ ? ' question' : '');
  root.dataset.index = idx;

  // Meta row: speaker badge + timestamp + question flag + CTA (React TranscriptView port)
  const meta = document.createElement('div');
  meta.className = 'utterance-meta';
  const spkId = (typeof utteranceSpeakers !== 'undefined' && utteranceSpeakers[idx] !== undefined) ? utteranceSpeakers[idx] : currentSpeakerId;
  const badge = document.createElement('span');
  badge.className = 'speaker-badge';
  badge.textContent = isQ ? i18nT('speaker_q') : (spkId % 2 === 1 ? i18nT('speaker_b') : i18nT('speaker_a'));
  meta.appendChild(badge);
  const now = new Date();
  const time = document.createElement('span');
  time.className = 'utterance-time';
  time.textContent = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  meta.appendChild(time);
  if (isQ) {
    const flag = document.createElement('span');
    flag.className = 'q-flag';
    flag.textContent = i18nT('q_flag');
    meta.appendChild(flag);
    meta.appendChild(buildQuestionCta());
  }
  root.appendChild(meta);

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
  const speakBtn = document.createElement('button');
  speakBtn.className = 'speak-mini-btn';
  speakBtn.type = 'button';
  speakBtn.title = 'Speak English (TTS)';
  speakBtn.textContent = '🔊 EN';
  speakBtn.addEventListener('click', () => {
    try { speakTextPorted(en, 'en-US'); } catch {}
  });
  copyRow.appendChild(speakBtn);
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
 * Append-only full-history archive for AI summary.
 * Every finalized EN utterance is tracked here in chronological order; this array
 * is NEVER spliced by compaction (only capped at FULL_HISTORY_MAX_UTTERANCES ≈
 * 4-6h of speech), so hour-long meetings keep their first 30 minutes.
 * Mirror of src/services/summary/summarySource.js appendFullHistory().
 * @param {string|string[]} texts
 */
function trackFullHistory(texts) {
  const arr = Array.isArray(texts) ? texts : [texts];
  for (const t of arr) {
    if (typeof t !== 'string' || !t.trim()) continue;
    fullEnHistory.push(t);
  }
  if (fullEnHistory.length > FULL_HISTORY_MAX_UTTERANCES) {
    fullEnHistory.splice(0, fullEnHistory.length - FULL_HISTORY_MAX_UTTERANCES);
  }
  syncState();
}

/**
 * Memory guard — drop oldest utterances once transcript exceeds 2x DOM cap,
 * then re-index arrays, DOM cache, suggestion map, selected idx, compress pointer.
 * Mirror of src/services/transcript/compact.js compactTranscriptState().
 * The dropped head is backfilled into fullEnHistory (upgrade/missed paths) so
 * AI summary keeps covering the whole meeting.
 * @returns {number} shift count (0 = nothing dropped)
 */
function compactTranscriptMemory() {
  const len = finalizedEnPhrases.length;
  if (len <= MAX_DOM_UTTERANCES * 2) return 0;
  const n = len - MAX_DOM_UTTERANCES;
  if (n <= 0) return 0;
  // Backfill dropped head into the summary archive (covers sessions compacted
  // before trackFullHistory existed or any missed append path — no duplicates
  // in normal flow because those items are already tracked at finalize time).
  const dropped = finalizedEnPhrases.slice(0, n);
  if (fullEnHistory.length === 0) {
    trackFullHistory(dropped);
  } else {
    const known = new Set(fullEnHistory);
    const missing = dropped.filter((u) => typeof u === 'string' && u.trim() && !known.has(u));
    if (missing.length > 0) trackFullHistory(missing);
  }
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
    // EN changed after build (split/merge/retry) — re-sync flag + CTA
    reconcileQuestionDom(cache);
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
    el.innerHTML = '<span class="vi-loading">' + escapeHtml(i18nT('translating_short')) + '</span>';
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
    if (playIcon) playIcon.style.display = 'none';
    if (stopIcon) stopIcon.style.display = 'block';
    btnText.innerText = i18nT('stop_live');
    try { if (logoDot) logoDot.classList.add('listening'); } catch {}
    if (liveBadge) { liveBadge.textContent = i18nT('badge_live'); liveBadge.classList.add('live'); }
    const footer = document.querySelector('.footer-status'); if (footer) footer.classList.add('live');
    toggleBtn.setAttribute('aria-label', 'Stop recording');
  } else {
    toggleBtn.className = 'btn btn-primary btn-record';
    if (playIcon) playIcon.style.display = 'block';
    if (stopIcon) stopIcon.style.display = 'none';
    btnText.innerText = i18nT('start_live');
    try { if (logoDot) logoDot.classList.remove('listening'); } catch {}
    if (liveBadge) { liveBadge.textContent = i18nT('badge_idle'); liveBadge.classList.remove('live'); }
    const footer = document.querySelector('.footer-status'); if (footer) footer.classList.remove('live');
    toggleBtn.setAttribute('aria-label', 'Start recording');
  }
}

/** Clear all state — idempotent, awaited storage, no throw */
async function clearContent() {
  finalizedEnPhrases = [];
  finalizedViPhrases = [];
  utteranceSpeakers = [];
  fullEnHistory = [];
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
  syncState();
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

/** Top-level stepper tabs: Context → Live → Summary. Guarded, no throw. */
function switchTopTab(name) {
  const btnContext = tabContext || document.getElementById('tabContext');
  const panelContext = contextTabContent || document.getElementById('contextTabContent');
  const tabs = {
    context: [btnContext, panelContext],
    live: [tabLive, liveTabContent],
    summary: [tabSummary, summaryTabContent],
  };
  if (!tabs[name]) return;
  try {
    for (const [key, [btn, panel]] of Object.entries(tabs)) {
      const on = key === name;
      if (btn) { btn.classList.toggle('active', on); btn.setAttribute('aria-selected', String(on)); }
      if (panel) {
        panel.classList.toggle('active-tab-content', on);
        panel.style.display = on ? 'flex' : 'none';
      }
    }
    if (name === 'summary' && typeof updateApiWarningState === 'function') updateApiWarningState();
    // Footer (status + Auto-scroll) only makes sense once live content exists — hide on step 1
    try {
      const footer = document.querySelector('.app-footer');
      if (footer) footer.style.display = name === 'context' ? 'none' : '';
    } catch {}
  } catch (e) { console.warn('[switchTopTab]', e); }
}

/** Tab nav — ARIA, guarded */
function setupTabNavigation() {
  const btnContext = tabContext || document.getElementById('tabContext');
  if (btnContext) btnContext.addEventListener('click', () => switchTopTab('context'));
  tabLive.addEventListener('click', () => switchTopTab('live'));
  tabSummary.addEventListener('click', () => switchTopTab('summary'));
}

/** Settings overlay — validated inputs, no throw */
function setupSettingsOverlay() {
  const presets = {
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
    ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' }
  };

  function syncThinkingLabel() {
    const label = document.getElementById('thinkingToggleLabel');
    if (label && thinkingToggle) label.textContent = thinkingToggle.checked ? 'ON' : 'OFF';
  }
  function fillSettings() {
    if (baseUrlInput) baseUrlInput.value = providerConfig.baseUrl || '';
    if (apiKeyInput) apiKeyInput.value = providerConfig.apiKey || '';
    if (modelInput) modelInput.value = providerConfig.model || '';
    if (geminiModelSelect) geminiModelSelect.value = providerConfig.model || '';
    if (thinkingToggle) thinkingToggle.checked = providerConfig.thinkingEnabled !== false;
    syncThinkingLabel();
  }
  if (thinkingToggle) thinkingToggle.addEventListener('change', syncThinkingLabel);

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
    const thinkingEnabled = thinkingToggle ? !!thinkingToggle.checked : (providerConfig.thinkingEnabled !== false);

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
      providerThinkingEnabled: thinkingEnabled,
      // keep legacy keys for compat
      geminiApiKey: key,
      geminiModel: model,
      geminiBaseUrl: baseUrl
    };
    chrome.storage.local.set(toSave, () => {
      providerConfig.baseUrl = baseUrl;
      providerConfig.apiKey = key;
      providerConfig.model = model;
      providerConfig.thinkingEnabled = thinkingEnabled;
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
    chrome.storage.local.get(['providerBaseUrl','providerApiKey','providerModel','providerThinkingEnabled','geminiBaseUrl','geminiApiKey','geminiModel'], (result) => {
      const baseUrl = result.providerBaseUrl || result.geminiBaseUrl || 'https://generativelanguage.googleapis.com/v1beta';
      const apiKey = result.providerApiKey !== undefined ? result.providerApiKey : (result.geminiApiKey || '');
      const model = result.providerModel || result.geminiModel || 'gemini-2.5-flash';
      const thinkingEnabled = result.providerThinkingEnabled !== undefined ? !!result.providerThinkingEnabled : true;
      providerConfig.baseUrl = baseUrl;
      providerConfig.apiKey = apiKey;
      providerConfig.model = model;
      providerConfig.thinkingEnabled = thinkingEnabled;
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
  // Whole-meeting source: append-only full history (survives compaction) +
  // early compressed bullets (covers pre-fix compacted heads).
  const utterances = getSummaryUtterances();
  const englishText = utterances.join(' ').trim();
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
  if (loadingP) loadingP.textContent = i18nT('analyzing_with', { m: providerConfig.model });

  const lang = summaryLangSelect.value;
  const detail = summaryDetailSelect.value;
  const model = providerConfig.model;

  // Map-reduce: split long meetings into chunks so the head is never truncated.
  // Single-chunk path keeps the exact previous single-call behavior.
  const chunks = splitSummaryChunksSide(utterances);

  try {
    let candidateText = '';
    if (chunks.length <= 1) {
      const prompt = buildSummaryPromptSide(englishText, lang, detail, 0, 1);
      candidateText = await callSummaryLLMSide(prompt);
    } else {
      const partSummaries = [];
      for (let i = 0; i < chunks.length; i++) {
        if (loadingP) loadingP.textContent = i18nT('summarizing_part', { i: i + 1, n: chunks.length, m: model });
        const partPrompt = buildSummaryPromptSide(chunks[i].join('\n'), lang, detail, i, chunks.length);
        partSummaries.push(await callSummaryLLMSide(partPrompt));
      }
      if (loadingP) loadingP.textContent = i18nT('merging_parts', { n: chunks.length, m: model });
      const mergePrompt = buildSummaryMergePromptSide(partSummaries, lang, detail);
      candidateText = await callSummaryLLMSide(mergePrompt);
    }

    if (!candidateText) throw new Error('API returned no content.');

    const renderedHtml = parseMarkdown(candidateText);
    summaryMarkdown.innerHTML = renderedHtml;
    summaryMarkdown.dataset.rawText = candidateText;
    summaryLoading.style.display = 'none';
    summaryMarkdown.style.display = 'block';
    copySummaryBtn.style.display = 'flex';
    const dlBtn = document.getElementById('downloadSummaryBtn');
    if (dlBtn) dlBtn.style.display = 'flex';
    try { enhanceSummaryChecklist(); } catch {}
    showStatus('Summary generated successfully');
    showToast(`Summarized with ${model} successfully`, 'success');
  } catch (error) {
    console.error('Provider error:', error);
    summaryLoading.style.display = 'none';
    summaryPlaceholder.style.display = 'flex';
    summaryPlaceholder.innerHTML = `<span style="color: #ef4444;">${i18nT('err_summary', { u: escapeHtml(providerConfig.baseUrl), e: escapeHtml(error.message) })}</span>`;
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

let lastStatusMsg = 'Ready';
/** @param {string} msg — raw message saved for i18n re-render, displayed translated */
function showStatus(msg) {
  if (!statusText) return;
  try { lastStatusMsg = msg; } catch {}
  const out = tt(msg);
  // statusText contains dot + span, preserve structure if exists
  const span = statusText.querySelector('span:last-child');
  if (span) span.innerText = out;
  else statusText.innerText = out;
}

/** Update word counts — pure calc, guarded DOM */
function updateWordCounts() {
  const enText = finalizedEnPhrases.join(' ').trim();
  const viText = finalizedViPhrases.join(' ').trim();
  const enCount = enText ? enText.split(/\s+/).length : 0;
  const viCount = viText ? viText.split(/\s+/).length : 0;
  const total = enCount + viCount;
  if (enWordCount) enWordCount.textContent = enCount + ' ' + i18nT('words');
  if (viWordCount) viWordCount.textContent = viCount + ' ' + i18nT('words');
  if (combinedWordCount) combinedWordCount.textContent = total ? `${enCount} EN • ${viCount} VI` : i18nT('no_words');
}

/** Schedule RAF word count — idempotent */
function scheduleWordCountUpdate() {
  if (wordCountRaf) return;
  wordCountRaf = requestAnimationFrame(() => {
    wordCountRaf = null;
    updateWordCounts();
  });
}

/** Show toast — validated, auto-dismiss, no throw. Uses textContent (XSS-safe, mirrors src/ui/components/toast.js) */
function showToast(message, type = 'default') {
  if (!toastContainer) return;
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  const icon = type === 'success' ? '✅' : type === 'error' ? '⚠️' : '💬';
  const iconEl = document.createElement('span');
  iconEl.className = 'toast-icon';
  iconEl.textContent = icon;
  const msgEl = document.createElement('span');
  msgEl.textContent = tt(message);
  toast.append(iconEl, msgEl);
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
    // Live sub-view shortcuts: 1/2/3 → Transcript/Answers/Both (live tab only, not while typing)
    if ((e.key === '1' || e.key === '2' || e.key === '3') && !e.ctrlKey && !e.metaKey && !e.altKey
        && !isTypingTarget(e.target)
        && typeof liveTabContent !== 'undefined' && liveTabContent
        && liveTabContent.classList.contains('active-tab-content')) {
      e.preventDefault();
      setLiveView(e.key === '1' ? 'transcript' : e.key === '2' ? 'answers' : 'split');
    }
  });
  // ARIA tab handling — arrow keys cycle through the 3 stepper tabs
  {
    const stepBtns = [tabContext || document.getElementById('tabContext'), tabLive, tabSummary].filter(Boolean);
    stepBtns.forEach((btn) => {
      btn.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const i = stepBtns.indexOf(btn);
        const next = stepBtns[(i + (e.key === 'ArrowRight' ? 1 : stepBtns.length - 1)) % stepBtns.length];
        next.focus(); next.click();
      });
    });
  }
}

/**
 * Authoritative utterance list for AI summary — chronological, whole meeting.
 * Prefers the append-only fullEnHistory (survives compactTranscriptMemory);
 * falls back to the live window for legacy sessions.
 * Mirror of src/services/summary/summarySource.js pickSummaryUtterances().
 * @returns {string[]}
 */
function getSummaryUtterances() {
  const full = Array.isArray(fullEnHistory) ? fullEnHistory.filter(Boolean) : [];
  if (full.length > 0) return full;
  return finalizedEnPhrases.filter(Boolean);
}

/** @returns {string} */
function getFullEnglishText() {
  return getSummaryUtterances().join(' ').trim();
}

/**
 * Split utterances into chronological chunks for map-reduce summary.
 * Every utterance is kept (never truncated) — long meetings produce more chunks.
 * Mirror of src/services/summary/summarySource.js splitSummaryChunks().
 * @param {string[]} utterances
 * @returns {string[][]}
 */
function splitSummaryChunksSide(utterances) {
  const list = Array.isArray(utterances) ? utterances.filter(Boolean) : [];
  const cap = Math.max(1000, SUMMARY_CHUNK_CHARS);
  if (list.length === 0) return [];
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const u of list) {
    const add = u.length + 1;
    if (cur.length > 0 && curLen + add > cap) { chunks.push(cur); cur = []; curLen = 0; }
    cur.push(u);
    curLen += add;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/**
 * Build the summary prompt for one transcript chunk. First chunk also carries
 * the early compressed history (covers sessions compacted before full history).
 * @param {string} chunkText
 * @param {string} lang 'vi' | 'en'
 * @param {string} detail 'bullets' | 'short' | 'action'
 * @param {number} idx chunk index (0-based)
 * @param {number} total total chunks
 * @returns {string}
 */
function buildSummaryPromptSide(chunkText, lang, detail, idx, total) {
  const LANG_NAME = { vi: 'Vietnamese', en: 'English', ja: 'Japanese', zh: 'Simplified Chinese' };
  const outLang = LANG_NAME[lang] || 'Vietnamese';
  const early = (idx === 0 && typeof compressedSummary === 'string' && compressedSummary.trim())
    ? `Earlier part of this same meeting (already-compressed bullets, may overlap with the transcript below — deduplicate, prefer transcript details):\n"""\n${compressedSummary.trim().slice(0, COMPRESSED_SUMMARY_MAX_CHARS)}\n"""\n\n`
    : '';
  let req = '';
  if (detail === 'bullets') {
    req = `- Format as detailed bullet points grouped by topics or main parts discussed.\n- Highlight key arguments or points raised by participants.\n`;
  } else if (detail === 'short') {
    req = total > 1
      ? `- Write a concise paragraph (max 5 sentences) covering this part's core topic and conclusions.\n`
      : `- Write a highly concise summary (max 2-3 short paragraphs) explaining the core topic and final conclusions.\n`;
  } else if (detail === 'action') {
    if (total > 1) {
      req = `- Extract Action Items from THIS part (who + deadline if mentioned). Empty list if none.\n`;
    } else {
      req = `- Extract and list Action Items, including who is responsible (if mentioned) and deadlines (if mentioned).\n- Structure them clearly as a checklist or to-do list.\n`;
    }
  }
  const partLabel = total > 1 ? ` (part ${idx + 1}/${total}, chronological)` : '';
  const intro = lang === 'vi'
    ? `You are a professional meeting assistant. Here is the meeting transcript in English`
    : `You are a professional meeting assistant. Here is the transcript of the meeting in English`;
  return `${intro}${partLabel}:\n\n${early}"""\n${chunkText}\n"""\n\nPlease generate a meeting summary in **${outLang}** with the following requirements:\n${req}- Format the output using clean Markdown, using headers (h2, h3) and bold text for emphasis. Do not use HTML.`;
}

/**
 * Merge per-chunk summaries into one whole-meeting summary prompt.
 * @param {string[]} chunkSummaries
 * @param {string} lang
 * @param {string} detail
 * @returns {string}
 */
function buildSummaryMergePromptSide(chunkSummaries, lang, detail) {
  const LANG_NAME = { vi: 'Vietnamese', en: 'English', ja: 'Japanese', zh: 'Simplified Chinese' };
  const outLang = LANG_NAME[lang] || 'Vietnamese';
  const parts = chunkSummaries.map((s, i) => `--- Part ${i + 1}/${chunkSummaries.length} summary ---\n${s}`).join('\n\n');
  let req = '';
  if (detail === 'bullets') {
    req = `- Format as detailed bullet points grouped by topics or main parts discussed.\n- Highlight key arguments or points raised by participants.\n`;
  } else if (detail === 'short') {
    req = `- Write a highly concise summary (max 2-3 short paragraphs) explaining the core topic and final conclusions.\n`;
  } else if (detail === 'action') {
    req = `- Extract and list Action Items, including who is responsible (if mentioned) and deadlines (if mentioned).\n- Structure them clearly as a checklist or to-do list.\n`;
  }
  return `You are a professional meeting assistant. Below are chronological per-part summaries of ONE meeting (part 1 = earliest).\n\n${parts}\n\nCombine them into a single coherent meeting summary in **${outLang}** covering the WHOLE meeting from start to finish (do not drop early parts):\n${req}- Format the output using clean Markdown, using headers (h2, h3) and bold text for emphasis. Do not use HTML.`;
}

/**
 * Single LLM call for summary (Gemini native or OpenAI-compatible).
 * @param {string} promptText
 * @returns {Promise<string>} candidate markdown text
 */
async function callSummaryLLMSide(promptText) {
  const baseUrl = providerConfig.baseUrl.replace(/\/+$/, '');
  const model = providerConfig.model;
  const apiKey = providerConfig.apiKey;
  const isGemini = baseUrl.includes('generativelanguage.googleapis.com');
  const thinkingOnSummary = isThinkingEnabledSide(providerConfig, {});
  const geminiThinkOffSummary = thinkingOnSummary ? {} : geminiThinkingOffConfigSide();
  const openaiThinkOffSummary = thinkingOnSummary ? {} : openaiThinkingOffParamsSide();
  let candidateText = '';
  if (isGemini) {
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }], ...(thinkingOnSummary ? {} : { generationConfig: { ...geminiThinkOffSummary } }) })
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw friendlyProviderErrorSide(response.status, bodyText, baseUrl);
    }
    const data = await response.json();
    candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } else {
    const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a helpful meeting assistant that outputs clean Markdown.' },
          { role: 'user', content: promptText }
        ],
        temperature: 0.7,
        ...openaiThinkOffSummary
      })
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw friendlyProviderErrorSide(response.status, bodyText, baseUrl);
    }
    const data = await response.json();
    candidateText = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
    if (!candidateText && data.message?.content) candidateText = data.message.content;
  }
  if (!candidateText) throw new Error('API returned no content.');
  return candidateText;
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

/* ============================================================
   PORTED FEATURES from live-copilot React app (additive, no break)
   - TTS speakTextPorted (helpers.speakText)
   - Theme light/dark + Help legend
   - Transcript search / question filter / submode / count / wave
   - Context presets + memory meter + copy-full
   - Summary download + interactive checklist
   ============================================================ */

/** TTS — port of React helpers.speakText */
function speakTextPorted(text, lang = 'en-US') {
  try {
    if (!('speechSynthesis' in window)) { showToast('TTS not supported', 'error'); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text || '').slice(0, 500));
    u.lang = lang;
    u.rate = 1.0;
    window.speechSynthesis.speak(u);
  } catch {}
}

/** Turn "- [ ] task" / "- [x] task" markdown into interactive checklist */
function enhanceSummaryChecklist() {
  if (!summaryMarkdown) return;
  const items = summaryMarkdown.querySelectorAll('li');
  let total = 0; let done = 0;
  items.forEach((li) => {
    const t = li.textContent || '';
    const m = t.match(/^\s*\[( |x|X)\]\s*(.*)$/);
    if (!m) return;
    total++;
    const checked = m[1].toLowerCase() === 'x';
    if (checked) done++;
    li.innerHTML = '';
    const label = document.createElement('label');
    label.className = 'md-task' + (checked ? ' done' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', () => {
      label.classList.toggle('done', cb.checked);
      updateMdTaskProgress();
    });
    const span = document.createElement('span');
    span.textContent = m[2];
    label.appendChild(cb);
    label.appendChild(span);
    li.appendChild(label);
  });
  if (total > 0) {
    const badge = document.createElement('div');
    badge.style.margin = '8px 0';
    badge.innerHTML = `<span class="md-task-progress" id="mdTaskProgress">${escapeHtml(i18nT('md_progress', { d: done, t: total }))}</span>`;
    summaryMarkdown.prepend(badge);
  }
}

function updateMdTaskProgress() {
  const boxes = summaryMarkdown ? summaryMarkdown.querySelectorAll('.md-task input[type="checkbox"]') : [];
  if (!boxes.length) return;
  let done = 0;
  boxes.forEach((b) => { if (b.checked) done++; });
  const badge = document.getElementById('mdTaskProgress');
  if (badge) badge.textContent = `${done} / ${boxes.length} hoàn thành`;
}

/** Memory meter: chars used vs MEMORY_BUDGET + counts (React ContextManagerView port) */
function updateMemoryMeter() {
  try {
    const fill = document.getElementById('memoryFill');
    const pct = document.getElementById('memoryPct');
    const meta = document.getElementById('memoryMeta');
    if (!fill || !pct || !meta) return;
    const budget = MEMORY_BUDGET;
    const used = (finalizedEnPhrases || []).join(' ').length + ((typeof compressedSummary === 'string') ? compressedSummary.length : 0);
    const p = Math.min(100, Math.round((used / budget) * 100));
    fill.style.width = p + '%';
    fill.classList.toggle('warn', p > 50 && p <= 80);
    fill.classList.toggle('danger', p > 80);
    pct.textContent = p + '%';
    const qCount = Object.keys(questionSuggestions || {}).length;
    meta.textContent = i18nT('mem_meta', { used: used.toLocaleString(), budget: budget.toLocaleString(), n: (finalizedEnPhrases || []).length, q: qCount });
  } catch {}
}

function initPortedFeatures() {
  // ---- Theme ----
  try {
    const root = document.documentElement;
    const lightBtn = document.getElementById('themeLightBtn');
    const darkBtn = document.getElementById('themeDarkBtn');
    const applyTheme = (t) => {
      root.setAttribute('data-theme', t);
      if (lightBtn) lightBtn.classList.toggle('active', t === 'light');
      if (darkBtn) darkBtn.classList.toggle('active', t === 'dark');
      try { localStorage.setItem('app_theme', t); } catch {}
      try { if (window.chrome && chrome.storage && chrome.storage.local) chrome.storage.local.set({ app_theme: t }); } catch {}
    };
    let saved = null;
    try { saved = localStorage.getItem('app_theme'); } catch {}
    applyTheme(saved === 'dark' ? 'dark' : 'light');
    if (window.chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['app_theme'], (r) => {
        if (r && (r.app_theme === 'light' || r.app_theme === 'dark')) applyTheme(r.app_theme);
      });
    }
    if (lightBtn) lightBtn.addEventListener('click', () => applyTheme('light'));
    if (darkBtn) darkBtn.addEventListener('click', () => applyTheme('dark'));
  } catch {}

  // ---- Help overlay ----
  try {
    const overlay = document.getElementById('helpOverlay');
    const openHelp = () => { if (overlay) overlay.style.display = 'flex'; };
    const closeHelp = () => { if (overlay) overlay.style.display = 'none'; };
    const hb = document.getElementById('helpBtn');
    const cb = document.getElementById('closeHelpBtn');
    const gb = document.getElementById('helpGotItBtn');
    if (hb) hb.addEventListener('click', openHelp);
    if (cb) cb.addEventListener('click', closeHelp);
    if (gb) gb.addEventListener('click', closeHelp);
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closeHelp(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay && overlay.style.display === 'flex') closeHelp();
    });
  } catch {}

  // ---- Header audio segmented (mockup) <-> legacy select ----
  try {
    const tabBtn = document.getElementById('audioTabBtn');
    const micBtn = document.getElementById('audioMicBtn');
    const sel = document.getElementById('audioSourceSelect');
    const paint = (v) => {
      if (tabBtn) tabBtn.classList.toggle('active', v === 'tab');
      if (micBtn) micBtn.classList.toggle('active', v === 'mic');
    };
    const setSource = (v) => {
      if (sel) sel.value = v;
      paint(v);
      try { if (window.chrome && chrome.storage && chrome.storage.local) chrome.storage.local.set({ audioSource: v }); } catch {}
    };
    if (tabBtn) tabBtn.addEventListener('click', () => setSource('tab'));
    if (micBtn) micBtn.addEventListener('click', () => setSource('mic'));
    if (sel) {
      paint(sel.value || 'tab');
      sel.addEventListener('change', () => paint(sel.value));
    }
  } catch {}

  // ---- Transcript search / filter / submode / count / wave ----
  try {
    const searchInput = document.getElementById('transcriptSearchInput');
    const filterBtn = document.getElementById('filterQuestionsBtn');
    const countEl = document.getElementById('utteranceCount');
    const wave = document.getElementById('waveAnim');
    const applySearch = () => {
      const q = (searchInput && searchInput.value ? searchInput.value : '').trim().toLowerCase();
      document.body.setAttribute('data-searching', q ? 'on' : 'off');
      (utteranceDomCache || []).forEach((c) => {
        if (!c || !c.root) return;
        if (!q) { c.root.classList.remove('search-hide'); return; }
        const en = (c.enText && c.enText.textContent ? c.enText.textContent : '').toLowerCase();
        const vi = (c.viText && c.viText.textContent ? c.viText.textContent : '').toLowerCase();
        c.root.classList.toggle('search-hide', !(en.includes(q) || vi.includes(q)));
      });
    };
    if (searchInput) searchInput.addEventListener('input', applySearch);
    if (filterBtn) filterBtn.addEventListener('click', () => {
      const on = filterBtn.getAttribute('aria-pressed') !== 'true';
      filterBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      document.body.setAttribute('data-qfilter', on ? 'on' : 'off');
    });
    document.querySelectorAll('.submode-btn').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.submode-btn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        document.body.setAttribute('data-submode', b.getAttribute('data-submode') || 'both');
      });
    });
    document.body.setAttribute('data-submode', 'both');
    document.body.setAttribute('data-qfilter', 'off');
    // expose refresh for append paths
    window.__refreshTranscriptMeta = () => {
      try {
        if (countEl) countEl.textContent = i18nT('count_speech', { n: (finalizedEnPhrases || []).length });
        applySearch();
        updateMemoryMeter();
      } catch {}
    };
    // wave follows listening state (poll cheap)
    setInterval(() => {
      try { if (wave) wave.hidden = !isListening; } catch {}
    }, 800);
    const origAppend = appendUtterance;
    // wrap via event: MutationObserver on feed to refresh count
    const feed = document.getElementById('transcriptFeed');
    if (feed && window.MutationObserver) {
      const mo = new MutationObserver(() => { try { window.__refreshTranscriptMeta(); } catch {} });
      mo.observe(feed, { childList: true });
    }
  } catch {}

  // ---- Context presets + copy full ----
  try {
    document.querySelectorAll('.ctx-preset').forEach((b) => {
      b.addEventListener('click', () => {
        const p = b.getAttribute('data-prompt') || '';
        const inp = document.getElementById('contextPromptInput');
        if (inp) {
          inp.value = p;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
        suggestContextPrompt = p;
        try { syncState(); } catch {}
        showToast('Đã áp dụng mẫu ngữ cảnh', 'success');
      });
    });
    const copyFull = document.getElementById('copyFullContextBtn');
    if (copyFull) copyFull.addEventListener('click', async () => {
      try {
        const raw = (finalizedEnPhrases || []).map((en, i) => `[${i}] ${en} → ${finalizedViPhrases[i] || ''}`).join('\n');
        const full = `Suggestion Context:\n${suggestContextPrompt || ''}\n\nCompressed Summary:\n${compressedSummary || ''}\n\nFull History:\n${raw}`;
        await navigator.clipboard.writeText(full);
        showToast('Đã sao chép full context', 'success');
      } catch { showToast('Copy failed', 'error'); }
    });
    setInterval(() => { try { updateMemoryMeter(); } catch {} }, 3000);
  } catch {}

  // ---- Summary download ----
  try {
    const dl = document.getElementById('downloadSummaryBtn');
    if (dl) dl.addEventListener('click', () => {
      try {
        const raw = (summaryMarkdown && summaryMarkdown.dataset.rawText) || '';
        if (!raw) { showToast('No summary to download', 'error'); return; }
        const blob = new Blob([raw], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Meeting_Summary_${Date.now()}.md`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        showToast('Downloaded .md', 'success');
      } catch { showToast('Download failed', 'error'); }
    });
  } catch {}
}

try {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPortedFeatures);
  else initPortedFeatures();
} catch {}
