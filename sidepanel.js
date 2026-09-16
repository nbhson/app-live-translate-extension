// Chrome Extension: Live Translate Side Panel Script
let recognition = null;
let isListening = false;
let lastFinalIndex = -1;
let activeAudioTrack = null;

let finalizedOffset = 0;
let silenceTimer = null;
const SILENCE_THRESHOLD = 1500; // 1.5s pause to force-finalize
const MAX_INTERIM_LENGTH = 100; // 100 characters to force-finalize

let finalizedEnPhrases = [];
let finalizedViPhrases = [];
let utteranceSpeakers = []; // parallel to finalizedEnPhrases, 0/1/2...
let questionSuggestions = {}; // index -> { state, question, answers, structures, error }
let suggestEnabled = true; // toggle via provider config
let utteranceDomCache = []; // index -> { root, enEl, viEl, viTextEl, enTextEl, copyEn, copyVi, suggestCard }
let pendingRenderQueue = new Set();
let renderScheduled = false;
let selectedQuestionIdx = null;
let suggestView = 'both'; // both | structure | complete

// Heuristic speaker diarization (local, no ML model)
let currentSpeakerId = 0;
let lastSpeakerFeatures = null; // { rms, centroid }
let speakerVadState = 'silence';
let speakerVadSilenceMs = 0;
let speakerVadLastSwitchAt = 0;
let speakerMonitor = null; // { ctx, analyser, dataFreq, dataTime, timer }
const SPEAKER_VAD_RMS_THRESH = 0.012; // ~ -38dB, tuned for tab/mic mix
const SPEAKER_MIN_PAUSE_MS = 350; // pause that may indicate speaker change
const SPEAKER_MIN_SPEECH_MS = 600; // ignore very short blips
const SPEAKER_CENTROID_DIFF = 320; // Hz diff to consider different voice

// Provider config state (custom: baseUrl + apiKey + model)
let providerConfig = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: '',
  model: 'gemini-2.5-flash'
};
// keep alias for backward compat in storage
let geminiConfig = providerConfig;

// DOM Elements
const toggleBtn = document.getElementById('toggleBtn');
const playIcon = document.getElementById('playIcon');
const stopIcon = document.getElementById('stopIcon');
const btnText = document.getElementById('btnText');
const clearBtn = document.getElementById('clearBtn');
const statusText = document.getElementById('statusText');
const logoDot = document.querySelector('.logo-dot');
const audioSourceSelect = document.getElementById('audioSourceSelect');

const englishLog = document.getElementById('englishLog');
const englishInterim = document.getElementById('englishInterim');
const enPlaceholder = document.getElementById('enPlaceholder');

const vietnameseLog = document.getElementById('vietnameseLog');
const vietnameseInterim = document.getElementById('vietnameseInterim');
const viPlaceholder = document.getElementById('viPlaceholder');

// Single-block elements
const transcriptFeed = document.getElementById('transcriptFeed');
const combinedPlaceholder = document.getElementById('combinedPlaceholder');
const transcriptContent = document.getElementById('transcriptContent');
const combinedWordCount = document.getElementById('combinedWordCount');
const interimBlock = document.getElementById('interimBlock');
const copyAllBtn = document.getElementById('copyAllBtn');
const suggestToggle = document.getElementById('suggestToggle');
const suggestionDock = document.getElementById('suggestionDock');
const qCountBadge = document.getElementById('qCountBadge');
const questionPills = document.getElementById('questionPills');
const suggestionBody = document.getElementById('suggestionBody');
const suggestEmpty = document.getElementById('suggestEmpty');
const clearSuggestionsBtn = document.getElementById('clearSuggestionsBtn');

const copyEnBtn = document.getElementById('copyEnBtn');
const copyViBtn = document.getElementById('copyViBtn');
const permissionOverlay = document.getElementById('permissionOverlay');
const grantPermissionBtn = document.getElementById('grantPermissionBtn');
const liveBadge = document.getElementById('liveBadge');
const enWordCount = document.getElementById('enWordCount');
const viWordCount = document.getElementById('viWordCount');
const toastContainer = document.getElementById('toastContainer');

// Tab Navigation Elements
const tabLive = document.getElementById('tabLive');
const tabSummary = document.getElementById('tabSummary');
const liveTabContent = document.getElementById('liveTabContent');
const summaryTabContent = document.getElementById('summaryTabContent');

// Settings Overlay Elements (Custom Provider)
const settingsBtn = document.getElementById('settingsBtn');
const settingsOverlay = document.getElementById('settingsOverlay');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const baseUrlInput = document.getElementById('baseUrlInput');
const apiKeyInput = document.getElementById('apiKeyInput');
const toggleApiKeyVisibilityBtn = document.getElementById('toggleApiKeyVisibilityBtn');
const modelInput = document.getElementById('modelInput');
const geminiModelSelect = document.getElementById('geminiModelSelect'); // legacy hidden
const saveSettingsBtn = document.getElementById('saveSettingsBtn');

// Summary Tab Elements
const apiWarningCard = document.getElementById('apiWarningCard');
const configNowBtn = document.getElementById('configNowBtn');
const summaryLangSelect = document.getElementById('summaryLang');
const summaryDetailSelect = document.getElementById('summaryDetail');
const generateSummaryBtn = document.getElementById('generateSummaryBtn');
const copySummaryBtn = document.getElementById('copySummaryBtn');
const summaryPlaceholder = document.getElementById('summaryPlaceholder');
const summaryMarkdown = document.getElementById('summaryMarkdown');
const summaryLoading = document.getElementById('summaryLoading');
const summaryContent = document.getElementById('summaryContent');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  setupTabNavigation();
  setupSettingsOverlay();
  setupSummaryFeatures();
  setupKeyboardShortcuts();
  setupSuggestToggle();
  setupSuggestionDock();
  await loadProviderConfig();
  await loadSuggestPref();
  await checkAndHidePermissionOverlay();
  updateWordCounts();
  updateDock();
});

async function loadSuggestPref() {
  try {
    const r = await chrome.storage.local.get(['suggestEnabled']);
    if (r.suggestEnabled !== undefined) {
      suggestEnabled = !!r.suggestEnabled;
      if (suggestToggle) suggestToggle.checked = suggestEnabled;
    }
  } catch {}
}
function setupSuggestToggle() {
  if (!suggestToggle) return;
  suggestToggle.addEventListener('change', async () => {
    suggestEnabled = suggestToggle.checked;
    try { await chrome.storage.local.set({ suggestEnabled }); } catch {}
    showToast(suggestEnabled ? 'Đã bật gợi ý AI' : 'Đã tắt gợi ý AI', 'default');
    if (!suggestEnabled) {
      // optionally keep existing suggestions but not generate new
    }
  });
}

// Check microphone permission and hide overlay if granted
async function checkAndHidePermissionOverlay() {
  const isGranted = await checkMicPermission();
  if (isGranted) {
    permissionOverlay.style.display = 'none';
    return true;
  }
  return false;
}

// Check microphone permission
async function checkMicPermission() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state === 'granted';
  } catch (e) {
    console.warn('navigator.permissions.query not supported for microphone', e);
    // Fallback check by attempting to query devices
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.some(device => device.kind === 'audioinput' && device.label !== '');
    } catch (err) {
      return false;
    }
  }
}

// Set up Event Listeners
function setupEventListeners() {
  toggleBtn.addEventListener('click', toggleListening);
  clearBtn.addEventListener('click', () => { clearContent(); showToast('Đã xóa lịch sử', 'success'); });
  
  if (copyEnBtn) copyEnBtn.addEventListener('click', () => {
    const text = getFullEnglishText();
    if (text) copyToClipboard(text, 'copyEnBtn');
    else showToast('Chưa có nội dung', 'default');
  });
  
  if (copyViBtn) copyViBtn.addEventListener('click', () => {
    const text = getFullVietnameseText();
    if (text) copyToClipboard(text, 'copyViBtn');
    else showToast('Chưa có bản dịch', 'default');
  });

  if (copyAllBtn) copyAllBtn.addEventListener('click', () => {
    const en = getFullEnglishText();
    const vi = getFullVietnameseText();
    if (!en && !vi) { showToast('Chưa có nội dung', 'default'); return; }
    const combined = `EN:\n${en}\n\nVI:\n${vi}`;
    copyToClipboard(combined, 'copyAllBtn');
  });

  grantPermissionBtn.addEventListener('click', openPermissionTab);

  // Track sticky scroll: user scrolled up -> stop auto-following until they return near bottom
  if (transcriptContent) {
    let stickScrollTick = false;
    transcriptContent.addEventListener('scroll', () => {
      if (stickScrollTick) return;
      stickScrollTick = true;
      requestAnimationFrame(() => {
        stickScrollTick = false;
        const autoScrollCheck = document.getElementById('autoScrollCheck');
        if (!autoScrollCheck || !autoScrollCheck.checked) {
          shouldStickToBottom = false;
          return;
        }
        shouldStickToBottom = isNearBottom();
      });
    }, { passive: true });
    // Initialize sticky state
    shouldStickToBottom = isNearBottom();
    // When the user toggles auto-scroll, re-evaluate stickiness
    const autoScrollCheckEl = document.getElementById('autoScrollCheck');
    if (autoScrollCheckEl) {
      autoScrollCheckEl.addEventListener('change', () => {
        if (autoScrollCheckEl.checked) {
          shouldStickToBottom = true;
          autoScroll(true);
        } else {
          shouldStickToBottom = false;
        }
      });
    }
  }

  // Re-check permission when the user focuses back on the side panel
  window.addEventListener('focus', async () => {
    const granted = await checkAndHidePermissionOverlay();
    if (granted && isListening === false && btnText.innerText === 'Bắt đầu') {
      showStatus('Sẵn sàng');
    }
  });
}

// Open the permission tab helper
function openPermissionTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
}

// Toggle Start/Stop Listening
async function toggleListening() {
  if (isListening) {
    stopListening();
    return;
  }

  const source = audioSourceSelect.value;
  if (source === 'tab') {
    startTabCapture();
  } else {
    // Microphone mode
    const isGranted = await checkMicPermission();
    if (!isGranted) {
      showPermissionOverlay();
      return;
    }
    startListening();
  }
}

// Start capturing tab audio
function startTabCapture() {
  showStatus('Đang kết nối âm thanh Tab...');
  
  // Request a fresh stream ID from the background service worker
  chrome.runtime.sendMessage({ type: 'get-tab-stream-id' }, async (response) => {
    if (!response || response.error) {
      const errorMsg = response ? response.error : 'Không có phản hồi từ background';
      console.error('get-tab-stream-id failed:', errorMsg);
      showStatus('Không thể thu âm tab này.');
      alert('Không thể thu âm tab này. Đảm bảo bạn đã click vào biểu tượng Extension ở thanh công cụ để kích hoạt và Tab hiện tại đang phát âm thanh.');
      audioSourceSelect.value = 'mic';
      return;
    }

    const streamId = response.streamId;
    
    try {
      // Capture the tab stream using the stream token
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        },
        video: false
      });

      // Loopback to speakers so the user can still hear the video
      window.capturedAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      window.capturedSource = window.capturedAudioContext.createMediaStreamSource(stream);
      window.capturedSource.connect(window.capturedAudioContext.destination);

      // Extract the audio track
      const tracks = stream.getAudioTracks();
      if (tracks.length === 0) {
        throw new Error('No audio tracks found in stream');
      }
      activeAudioTrack = tracks[0];
      window.capturedStream = stream;
      setupSpeakerMonitor(stream);

      // Start speech recognition
      startListening();
    } catch (err) {
      console.error('Failed to process captured tab audio:', err);
      showStatus('Lỗi kết nối âm thanh tab. Đang thử bằng Microphone...');
      alert('Không thể kết nối âm thanh tab. Tự động chuyển sang chế độ Microphone.');
      audioSourceSelect.value = 'mic';
      cleanupTabCapture();
      
      // Fallback to mic
      const isGranted = await checkMicPermission();
      if (isGranted) startListening();
    }
  });
}

// Clean up tab capture resources
function cleanupTabCapture() {
  teardownSpeakerMonitor();
  if (window.capturedStream) {
    window.capturedStream.getTracks().forEach(track => track.stop());
    window.capturedStream = null;
  }
  activeAudioTrack = null;
  if (window.capturedAudioContext) {
    try {
      window.capturedAudioContext.close();
    } catch (e) {}
    window.capturedAudioContext = null;
  }
}

// --- Heuristic speaker monitor (local VAD + centroid) ---
function setupSpeakerMonitor(stream) {
  teardownSpeakerMonitor();
  try {
    const ctx = window.capturedAudioContext || new (window.AudioContext || window.webkitAudioContext)();
    if (!window.capturedAudioContext) window.capturedAudioContext = ctx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);
    // keep audible loopback if it was tab capture (already connected), avoid double connect
    const dataFreq = new Uint8Array(analyser.frequencyBinCount);
    const dataTime = new Uint8Array(analyser.fftSize);
    speakerMonitor = { ctx, analyser, dataFreq, dataTime, stream, timer: null, lastRms: 0, lastCentroid: 0, speechStartAt: 0 };
    speakerVadState = 'silence';
    speakerVadSilenceMs = 0;
    // sample every 60ms
    let lastTick = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = now - lastTick;
      lastTick = now;
      analyser.getByteTimeDomainData(dataTime);
      analyser.getByteFrequencyData(dataFreq);
      let sum = 0;
      for (let i = 0; i < dataTime.length; i++) {
        const v = (dataTime[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / dataTime.length);
      const centroid = computeSpectralCentroid(dataFreq, ctx.sampleRate);
      const isSpeech = rms > SPEAKER_VAD_RMS_THRESH;
      if (isSpeech) {
        if (speakerVadState === 'silence') {
          // speech just started
          const pauseLen = speakerVadSilenceMs;
          speakerVadState = 'speech';
          speakerMonitor.speechStartAt = now;
          if (pauseLen >= SPEAKER_MIN_PAUSE_MS) {
            const feats = { rms, centroid };
            if (shouldToggleSpeaker(feats, pauseLen)) {
              currentSpeakerId = (currentSpeakerId + 1) % 2;
              // force a live block cut so next interim gets a fresh block with new speaker
              maybeCutLiveOnSpeakerChange();
            }
            lastSpeakerFeatures = feats;
          } else if (!lastSpeakerFeatures) {
            lastSpeakerFeatures = { rms, centroid };
          }
        } else {
          // update running features for current speech segment
          if (lastSpeakerFeatures) {
            lastSpeakerFeatures.rms = lastSpeakerFeatures.rms * 0.85 + rms * 0.15;
            lastSpeakerFeatures.centroid = lastSpeakerFeatures.centroid * 0.85 + centroid * 0.15;
          }
        }
        speakerVadSilenceMs = 0;
      } else {
        // silence
        if (speakerVadState === 'speech') {
          speakerVadState = 'silence';
        }
        speakerVadSilenceMs += dt;
      }
      speakerMonitor.lastRms = rms;
      speakerMonitor.lastCentroid = centroid;
    };
    speakerMonitor.timer = setInterval(tick, 60);
  } catch (e) {
    console.warn('setupSpeakerMonitor failed', e);
  }
}
function teardownSpeakerMonitor() {
  if (speakerMonitor && speakerMonitor.timer) {
    clearInterval(speakerMonitor.timer);
  }
  speakerMonitor = null;
  speakerVadState = 'silence';
  speakerVadSilenceMs = 0;
}
function computeSpectralCentroid(freqData, sampleRate) {
  const nyquist = sampleRate / 2;
  const binHz = nyquist / freqData.length;
  let sumAmp = 0, sumWeighted = 0;
  for (let i = 0; i < freqData.length; i++) {
    const amp = freqData[i] / 255;
    if (amp < 0.02) continue;
    sumAmp += amp;
    sumWeighted += amp * (i * binHz);
  }
  return sumAmp > 0 ? sumWeighted / sumAmp : 0;
}
function shouldToggleSpeaker(feats, pauseLen) {
  if (!lastSpeakerFeatures) return false;
  const now = performance.now();
  if (now - speakerVadLastSwitchAt < 900) return false; // debounce speaker flips
  const rmsDiff = Math.abs(feats.rms - lastSpeakerFeatures.rms);
  const centDiff = Math.abs(feats.centroid - lastSpeakerFeatures.centroid);
  // longer pause lowers threshold a bit
  const centThresh = pauseLen > 700 ? SPEAKER_CENTROID_DIFF * 0.75 : SPEAKER_CENTROID_DIFF;
  const rmsThresh = 0.04;
  // centroid is more discriminative than rms for different voices
  if (centDiff > centThresh) {
    speakerVadLastSwitchAt = now;
    return true;
  }
  if (rmsDiff > rmsThresh && centDiff > centThresh * 0.6) {
    speakerVadLastSwitchAt = now;
    return true;
  }
  return false;
}
function maybeCutLiveOnSpeakerChange() {
  const lastCache = utteranceDomCache[utteranceDomCache.length - 1];
  if (!lastCache || !lastCache.isLive) return;
  const liveText = (lastCache.enText && lastCache.enText.textContent || '').trim();
  if (!liveText) return;
  // finalize current live block immediately with its current text, start fresh live for new speaker
  const curLen = liveText.length;
  // use rawLength = finalizedOffset + curLen so finalize offset logic stays consistent
  const rawLen = finalizedOffset + curLen;
  forceFinalizeText(liveText, rawLen);
}

// Show Permission Overlay
function showPermissionOverlay() {
  permissionOverlay.style.display = 'flex';
  showStatus('Cần cấp quyền microphone');
}

// Start Speech Recognition
function startListening() {
  if (!recognition) {
    initRecognition();
  }
  
  if (recognition) {
    try {
      lastFinalIndex = -1; // Reset index for new session
      finalizedOffset = 0; // Reset offset for new session
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      
      if (activeAudioTrack) {
        recognition.start(activeAudioTrack);
      } else {
        // Mic mode: also spin up a lightweight monitor from a parallel mic stream (best-effort)
        setupMicSpeakerMonitor().catch(() => {});
        recognition.start();
      }
    } catch (e) {
      console.error('Error starting recognition:', e);
      // If passing track fails (e.g. browser doesn't support track parameter yet)
      if (activeAudioTrack) {
        console.warn('Track-based recognition failed. Falling back to default microphone...');
        activeAudioTrack = null;
        try {
          recognition.start();
        } catch (err) {
          console.error('Fallback microphone start failed:', err);
        }
      }
    }
  }
}

async function setupMicSpeakerMonitor() {
  if (speakerMonitor || window.capturedStream) return;
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // keep track so we can stop it on stopListening
    window.micMonitorStream = micStream;
    setupSpeakerMonitor(micStream);
  } catch {}
}

// Stop Speech Recognition
function stopListening() {
  isListening = false;
  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {
      console.error('Error stopping recognition:', e);
    }
  }
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  teardownSpeakerMonitor();
  if (window.micMonitorStream) {
    try { window.micMonitorStream.getTracks().forEach(t => t.stop()); } catch {}
    window.micMonitorStream = null;
  }
  cleanupTabCapture();
  updateUIForListening(false);
  showStatus('Đã dừng');
}

// Initialize SpeechRecognition Engine
function initRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showStatus('Trình duyệt không hỗ trợ Speech Recognition.');
    return;
  }
  
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  
  recognition.onstart = () => {
    isListening = true;
    updateUIForListening(true);
    if (activeAudioTrack) {
      showStatus('Đang dịch âm thanh Tab...');
    } else {
      showStatus('Đang nghe tiếng Anh (Mic)...');
    }
  };
  
  recognition.onresult = async (event) => {
    let interimEn = '';
    
    // Clear silence timer on every new speech piece
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const result = event.results[i];
      
      if (result.isFinal) {
        if (i > lastFinalIndex) {
          lastFinalIndex = i;
          
          const rawText = result[0].transcript;
          // Extract remaining text that was not finalized by our timed triggers
          const remainingText = rawText.substring(finalizedOffset).trim();
          
          // Reset offset for next index block
          finalizedOffset = 0;
          
          if (remainingText) {
            await finalizeText(remainingText);
          }
        }
      } else {
        const rawText = result[0].transcript;
        
        // Safety guard for offset bounds
        if (finalizedOffset > rawText.length) {
          finalizedOffset = rawText.length;
        }
        
        interimEn = rawText.substring(finalizedOffset).trim();
      }
    }
    
    if (interimEn) {
      hidePlaceholders();
      // Live: render interim into the last utterance slot (sticky live block)
      ensureLiveUtterance();
      const liveCache = utteranceDomCache[utteranceDomCache.length - 1];
      if (liveCache && liveCache.enText) {
        liveCache.enText.textContent = interimEn;
        liveCache.enText.classList.add('typing');
      }
      // Follow the live feed only while the user is near the bottom (sticky)
      autoScroll();

      // Trigger timer
      const lastResultIndex = event.results.length - 1;
      const currentRawTextLength = event.results[lastResultIndex][0].transcript.length;

      if (interimEn.length >= MAX_INTERIM_LENGTH) {
        await forceFinalizeText(interimEn, currentRawTextLength);
      } else {
        silenceTimer = setTimeout(async () => {
          await forceFinalizeText(interimEn, currentRawTextLength);
        }, SILENCE_THRESHOLD);
      }
    }
  };
  
  recognition.onerror = (event) => {
    console.error('Recognition error:', event.error);
    if (event.error === 'not-allowed') {
      showPermissionOverlay();
      stopListening();
    } else if (event.error === 'no-speech') {
      // Just ignore, SpeechRecognition continuous handles this
    } else {
      showStatus(`Lỗi: ${event.error}`);
      stopListening();
    }
  };
  
  recognition.onend = () => {
    if (isListening) {
      // Auto-restart if we didn't explicitly stop
      try {
        lastFinalIndex = -1;
        finalizedOffset = 0;
        if (activeAudioTrack) {
          recognition.start(activeAudioTrack);
        } else {
          recognition.start();
        }
      } catch (e) {
        console.error('Auto-restart failed:', e);
      }
    } else {
      updateUIForListening(false);
    }
  };
}

// Helper: detect question in EN
function isQuestion(text) {
  const t = text.trim();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  // English question patterns
  const qPattern = /^(who|what|when|where|why|how|which|whom|whose|is|are|was|were|do|does|did|can|could|would|will|shall|should|may|might|have|has|had|am|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|could you|would you|will you|can you|do you|are you|have you|has anyone|is there|are there)\b/i;
  if (qPattern.test(t)) {
    // avoid false positives for short declaratives; require at least 3 words or ends without period
    const words = t.split(/\s+/);
    if (words.length >= 3) return true;
  }
  // also Vietnamese question mark already handled
  return false;
}

function buildSuggestPrompt(question, contextEn) {
  const ctx = contextEn.slice(-4).join(' | ');
  return `You are a helpful assistant for a bilingual EN->VI meeting. The user just heard an English question and needs quick suggested answers in English (natural, concise, polite).

Context (last utterances): """${ctx}"""

Question: """${question}"""

Task: Return JSON with two fields:
- "structures": 3 short structure hints (3-7 words each, like "Friendly response + acknowledge shared origin + light detail")
- "answers": 3 full natural answers in English (1 sentence each, diverse angles: friendly / concise / playful etc, each may contain placeholder [City, Country] if location question).

Output ONLY JSON object, e.g. {"structures":["Hint 1","Hint 2","Hint 3"],"answers":["Answer 1","Answer 2","Answer 3"]}. No markdown, no extra text.`;
}

async function callProviderForSuggest(prompt) {
  const baseUrl = providerConfig.baseUrl.replace(/\/+$/, '');
  const model = providerConfig.model;
  const apiKey = providerConfig.apiKey;
  const isGemini = baseUrl.includes('generativelanguage.googleapis.com');
  if (isGemini) {
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.8, maxOutputTokens: 512 } })
    });
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
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You output ONLY JSON object with "structures" and "answers" arrays. No markdown, no extra text.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.85,
        max_tokens: 512
      })
    });
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

function parseSuggestAnswers(raw) {
  if (!raw) return { structures: [], answers: [] };
  // try JSON object {structures, answers}
  try {
    const objMatch = raw.match(/\{[\s\S]*\}/);
    if (objMatch) {
      const obj = JSON.parse(objMatch[0]);
      if (obj && (obj.answers || obj.structures)) {
        const structures = Array.isArray(obj.structures) ? obj.structures.slice(0,5).map(s=>String(s).trim()).filter(Boolean) : [];
        const answers = Array.isArray(obj.answers) ? obj.answers.slice(0,5).map(s=>String(s).trim()).filter(Boolean) : [];
        if (answers.length || structures.length) return { structures, answers };
      }
      // fallback if object is array
      if (Array.isArray(obj)) return { structures: [], answers: obj.slice(0,5).map(s=>String(s).trim()).filter(Boolean) };
    }
  } catch {}
  try {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) return { structures: [], answers: arr.slice(0,5).map(s => String(s).trim()).filter(Boolean) };
    }
  } catch {}
  const lines = raw.split(/\n/).map(s => s.replace(/^[\s\-\*\d\.\u2022]+/, '').trim()).filter(Boolean).slice(0,5);
  return { structures: [], answers: lines };
}

function synthesizeStructures(answers) {
  // fallback: generate short hint from answer prefix
  return answers.map(a => {
    const words = a.split(/\s+/).slice(0,6).join(' ');
    return words.length > 40 ? words.slice(0,40)+'…' : words;
  });
}

async function triggerSuggestForIndex(idx, question) {
  if (!suggestEnabled) return;
  const isLocal = providerConfig.baseUrl.includes('localhost') || providerConfig.baseUrl.includes('127.0.0.1');
  if (!providerConfig.baseUrl || !providerConfig.model || (!providerConfig.apiKey && !isLocal)) {
    questionSuggestions[idx] = { state: 'error', question, answers: [], structures: [], error: 'Chưa cấu hình AI Provider' };
    updateSuggestCard(idx);
    updateDock();
    return;
  }
  questionSuggestions[idx] = { state: 'loading', question, answers: [], structures: [] };
  // auto-select this question
  selectedQuestionIdx = idx;
  updateSuggestCard(idx);
  updateDock();
  try {
    const prompt = buildSuggestPrompt(question, finalizedEnPhrases.slice(Math.max(0, idx-3), idx+1));
    const raw = await callProviderForSuggest(prompt);
    const parsed = parseSuggestAnswers(raw);
    let { structures, answers } = parsed;
    if (answers.length === 0 && structures.length === 0) throw new Error('Không parse được gợi ý');
    if (answers.length === 0) answers = structures;
    if (structures.length === 0) structures = synthesizeStructures(answers);
    // ensure limits
    answers = answers.slice(0,3);
    structures = structures.slice(0,3);
    questionSuggestions[idx] = { state: 'done', question, answers, structures };
  } catch (e) {
    questionSuggestions[idx] = { state: 'error', question, answers: [], structures: [], error: e.message || 'Lỗi AI' };
  }
  updateSuggestCard(idx);
  updateDock();
  autoScroll();
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
      showToast('Đã xóa gợi ý', 'success');
    });
  }
}

function updateDock() {
  if (!suggestionDock) return;
  const entries = Object.entries(questionSuggestions).sort((a,b)=>Number(a[0])-Number(b[0]));
  const count = entries.length;
  if (qCountBadge) qCountBadge.textContent = `${count} câu hỏi`;
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
}

function renderDockBody() {
  if (!suggestionBody) return;
  if (Object.keys(questionSuggestions).length === 0) {
    suggestionBody.innerHTML = '<div class="suggest-empty" id="suggestEmpty">Chưa có câu hỏi nào. Khi AI phát hiện câu hỏi, gợi ý sẽ hiện ở đây.</div>';
    return;
  }
  if (selectedQuestionIdx === null || !questionSuggestions[selectedQuestionIdx]) {
    suggestionBody.innerHTML = '<div class="suggest-empty">Chọn một câu hỏi ở trên để xem gợi ý.</div>';
    return;
  }
  const data = questionSuggestions[selectedQuestionIdx];
  if (data.state === 'loading') {
    suggestionBody.innerHTML = `<div class="suggest-loading" style="padding:12px;display:flex;gap:8px;align-items:center;color:var(--text-2);font-size:12px"><div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Đang tạo gợi ý cho: <em>${escapeHtml(data.question||'')}</em></div>`;
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
        <span class="suggest-actions"><button class="suggest-copy" data-text="${escapeHtml(s).replace(/"/g,'&quot;')}" title="Sao chép">⎘</button></span>
      </div>
    `).join('') + `</div>`;
  }
  if (showComplete) {
    html += `<div class="dock-complete-label">Câu trả lời hoàn chỉnh</div>`;
    html += data.answers.map(a=>`
      <div class="dock-complete-card">
        <span style="flex:1">${escapeHtml(a)}</span>
        <button class="copy-btn" data-text="${escapeHtml(a).replace(/"/g,'&quot;')}">Copy</button>
      </div>
    `).join('');
  }
  suggestionBody.innerHTML = html;
  suggestionBody.querySelectorAll('[data-text]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const txt = btn.getAttribute('data-text');
      if (txt) { await navigator.clipboard.writeText(txt); showToast('Đã sao chép','success'); }
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
const SENT_END_RE = /(?<=[.!?])\s+(?=[A-Z0-9"']|\()|(?<=[.!?])\s*$/;
const STRONG_SPLIT_WORDS = ['how','what','why','where','when'];
// Minimum context before a split word: the segment before it must have at
// least this many words to count as a separate clause.
const MIN_PREFIX_WORDS = 3;

function splitIntoUtterances(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const segs = trimmed
    .split(SENT_END_RE)
    .map(s => s.trim())
    .filter(Boolean);
  const out = [];
  for (const seg of segs) {
    // Try to find the first occurrence of a strong split word that is NOT at
    // position 0 and has enough context before it.
    const lower = seg.toLowerCase();
    let splitPos = -1;
    for (const word of STRONG_SPLIT_WORDS) {
      const idx = lower.indexOf(word + ' ');
      // also allow end-of-string match
      const idxNoSpace = idx === -1 ? lower.lastIndexOf(word) : idx;
      const useIdx = idx !== -1 ? idx : idxNoSpace;
      if (useIdx > 0) {
        // count words before
        const prefix = seg.slice(0, useIdx).trim();
        const prefixWords = prefix ? prefix.split(/\s+/).length : 0;
        if (prefixWords >= MIN_PREFIX_WORDS) {
          splitPos = useIdx;
          break;
        }
      }
    }
    if (splitPos > 0) {
      const left = seg.slice(0, splitPos).trim();
      const right = seg.slice(splitPos).trim();
      if (left) out.push(left);
      if (right) out.push(right);
    } else {
      out.push(seg);
    }
  }
  return out.filter(Boolean);
}

// Helper to finalize and translate a block of text (now splits into utterances)
async function finalizeText(text) {
  const cleanText = text.trim();
  if (!cleanText) return;

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
    showStatus('Đang dịch...');
    const translated = await translateText(cleanText);
    finalizedViPhrases[idx] = translated || '[Không thể dịch]';
    if (liveCache) {
      setViText(liveCache.viText, finalizedViPhrases[idx]);
      liveCache.copyVi.dataset.text = finalizedViPhrases[idx];
      liveCache.copyVi.disabled = false;
      if (liveCache.colVi && finalizedViPhrases[idx] !== '[Không thể dịch]') {
        liveCache.colVi.classList.add('vi-just-arrived');
        setTimeout(() => liveCache.colVi.classList.remove('vi-just-arrived'), 800);
      }
    }
    updateWordCounts();
    if (activeAudioTrack) {
      showStatus('Đang dịch âm thanh Tab...');
    } else {
      showStatus('Đang nghe tiếng Anh (Mic)...');
    }
    // Promoting live -> layout changes; force sticky scroll to the new final utterance
    shouldStickToBottom = true;
    autoScroll(true);

    // After translation, detect question and trigger AI suggest (non-blocking)
    if (isQuestion(cleanText)) {
      triggerSuggestForIndex(idx, cleanText);
    }
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
  // Capture stickiness before appending new nodes (scrollHeight will grow)
  if (isNearBottom()) shouldStickToBottom = true;
  // Append each new utterance to the feed (DOM, no full re-render)
  for (let i = 0; i < utterances.length; i++) {
    const idx = firstIdx + i;
    if (!utteranceDomCache[idx]) {
      appendUtterance(idx);
    }
  }
  updateWordCounts();

  // Translate each utterance, updating the DOM in place (no full re-render)
  showStatus('Đang dịch...');
  for (let k = 0; k < utterances.length; k++) {
    const idx = firstIdx + k;
    const cache = utteranceDomCache[idx];
    // Skip translation entirely when this slot already has a result (e.g. re-finalize)
    if (finalizedViPhrases[idx] && finalizedViPhrases[idx] !== '…') {
      if (cache) {
        setViText(cache.viText, finalizedViPhrases[idx]);
        cache.copyVi.dataset.text = finalizedViPhrases[idx];
        cache.copyVi.disabled = false;
      }
      continue;
    }
    const translated = await translateText(utterances[k]);
    finalizedViPhrases[idx] = translated || '[Không thể dịch]';
    // Update only this utterance's VI text in place
    if (cache) {
      setViText(cache.viText, finalizedViPhrases[idx]);
      cache.copyVi.dataset.text = finalizedViPhrases[idx];
      cache.copyVi.disabled = false;
      // Flash the VI column to show it just arrived
      if (cache.colVi && finalizedViPhrases[idx] !== '[Không thể dịch]') {
        cache.colVi.classList.add('vi-just-arrived');
        setTimeout(() => cache.colVi.classList.remove('vi-just-arrived'), 800);
      }
    }
    updateWordCounts();
  }

  if (activeAudioTrack) {
    showStatus('Đang dịch âm thanh Tab...');
  } else {
    showStatus('Đang nghe tiếng Anh (Mic)...');
  }

  // Clear interim display
  if (englishInterim) englishInterim.innerText = '';
  if (vietnameseInterim) vietnameseInterim.innerText = '';
  if (interimBlock) interimBlock.style.display = 'none';
  shouldStickToBottom = true;
  autoScroll(true);

  // After translation, detect question and trigger AI suggest (non-blocking)
  utterances.forEach((u, k) => {
    if (isQuestion(u)) {
      triggerSuggestForIndex(firstIdx + k, u);
    }
  });
}

// Force finalize from interim speech
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

// Live utterance helpers: the last feed item acts as the "live" block while speech
// is in progress. It is finalized in place (no re-ordering, no layout jump).
function ensureLiveUtterance() {
  const lastCache = utteranceDomCache[utteranceDomCache.length - 1];
  if (lastCache && lastCache.isLive) return lastCache;
  // Capture stickiness before DOM grows (scrollHeight will increase)
  const wasNear = isNearBottom();
  if (wasNear) shouldStickToBottom = true;
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

// Translate Text via Google Translate free API
async function translateText(text) {
  if (!text || !text.trim()) return '';
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    if (data && data[0]) {
      let translation = '';
      for (let i = 0; i < data[0].length; i++) {
        if (data[0][i] && data[0][i][0]) {
          translation += data[0][i][0];
        }
      }
      return translation;
    }
    return '';
  } catch (error) {
    console.error('Translation error:', error);
    return '';
  }
}

// Update the live VI preview inside the live utterance (debounced)
let liveViDebounce = null;
function debouncedTranslateInterim(text) {
  if (liveViDebounce) {
    clearTimeout(liveViDebounce);
  }

  liveViDebounce = setTimeout(async () => {
    if (!text || !text.trim()) {
      return;
    }
    // Only update while this is still the live utterance
    const liveCache = utteranceDomCache[utteranceDomCache.length - 1];
    if (!liveCache || !liveCache.isLive) return;

    const translated = await translateText(text);
    // Re-check live state after the async translation
    const stillLive = utteranceDomCache[utteranceDomCache.length - 1];
    if (stillLive && stillLive.isLive && liveCache.enText && liveCache.enText.textContent === text) {
      setViText(liveCache.viText, translated);
    }
  }, 300);
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
  copyEn.title = 'Sao chép EN';
  copyEn.innerHTML = '<span class="lang-tag">EN</span> ⎘';
  const copyVi = document.createElement('button');
  copyVi.className = 'copy-mini-btn copy-vi';
  copyVi.dataset.text = (vi !== '…') ? vi : '';
  copyVi.title = 'Sao chép VI';
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
      showToast('Đã sao chép', 'success');
    }
  };
  copyEn.addEventListener('click', () => handleCopy(copyEn));
  copyVi.addEventListener('click', () => handleCopy(copyVi));

  // Insert into feed (before the interim block if present, so interim stays at bottom)
  if (interimBlock && interimBlock.parentNode === transcriptFeed) {
    transcriptFeed.insertBefore(root, interimBlock);
  } else {
    transcriptFeed.appendChild(root);
  }

  return {
    root, body, colEn, colVi, enText, viText, copyEn, copyVi, suggestCard,
    isLive: false
  };
}

// Add a single utterance to the feed (new item at the end)
function appendUtterance(idx) {
  const en = finalizedEnPhrases[idx] || '';
  const vi = finalizedViPhrases[idx] !== undefined ? finalizedViPhrases[idx] : '…';
  const spk = utteranceSpeakers[idx] !== undefined ? utteranceSpeakers[idx] : currentSpeakerId;

  const cache = buildUtteranceDom(idx, en, vi);
  cache._speakerId = spk;
  applySpeakerToDom(cache, spk);
  utteranceSpeakers[idx] = spk;
  utteranceDomCache[idx] = cache;

  // Auto scroll
  autoScroll();

  // If there's a suggestion state, render it
  updateSuggestCard(idx);
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
    el.innerHTML = '<span class="vi-loading">Đang dịch…</span>';
  } else {
    el.textContent = vi;
  }
}

// Smooth auto-scroll: sticky to bottom unless the user has scrolled up
// Fix: isNearBottom must be evaluated BEFORE DOM growth, and throttling must coalesce.
let scrollScheduled = false;
let pendingScrollForce = false;
// Track whether the user wants sticky follow (true = near bottom or fresh session)
let shouldStickToBottom = true;

function isNearBottom() {
  if (!transcriptContent) return true;
  return (transcriptContent.scrollHeight - transcriptContent.scrollTop - transcriptContent.clientHeight) < 120;
}
function autoScroll(force = false) {
  if (force) pendingScrollForce = true;
  // Capture stickiness at call time (before RAF, before next DOM growth is measured)
  const autoScrollCheck = document.getElementById('autoScrollCheck');
  const enabled = !!(autoScrollCheck && autoScrollCheck.checked);
  if (!enabled) {
    // still schedule so pendingScrollForce is cleared correctly
    return;
  }
  if (!force) {
    // Only stick if the user was already near bottom at this moment.
    // If the user scrolled up, we respect that and do not yank them down.
    // shouldStickToBottom is updated on scroll events; fallback to live isNearBottom().
    if (!shouldStickToBottom && !isNearBottom()) return;
  }
  if (scrollScheduled) {
    // coalesce: keep pending force flag, actual scroll will happen on the scheduled frame
    return;
  }
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    const mustForce = pendingScrollForce;
    pendingScrollForce = false;
    if (!transcriptContent || !enabled) return;
    if (mustForce || shouldStickToBottom || isNearBottom()) {
      transcriptContent.scrollTo({
        top: transcriptContent.scrollHeight,
        behavior: 'smooth'
      });
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Hide place holder text
function hidePlaceholders() {
  if (enPlaceholder) enPlaceholder.style.display = 'none';
  if (viPlaceholder) viPlaceholder.style.display = 'none';
  if (combinedPlaceholder) combinedPlaceholder.style.display = 'none';
}

// Show placeholders
function showPlaceholders() {
  const hasData = finalizedEnPhrases.length > 0;
  if (!hasData) {
    if (combinedPlaceholder) combinedPlaceholder.style.display = 'flex';
    if (enPlaceholder) enPlaceholder.style.display = 'none';
    if (viPlaceholder) viPlaceholder.style.display = 'none';
  }
}

// Update UI States when listening/stopped
function updateUIForListening(active) {
  if (active) {
    toggleBtn.className = 'btn btn-danger btn-record';
    playIcon.style.display = 'none';
    stopIcon.style.display = 'block';
    btnText.innerText = 'Dừng';
    logoDot.classList.add('listening');
    if (liveBadge) { liveBadge.textContent = '● LIVE'; liveBadge.classList.add('live'); }
    const footer = document.querySelector('.footer-status'); if (footer) footer.classList.add('live');
    toggleBtn.setAttribute('aria-label', 'Dừng ghi âm');
  } else {
    toggleBtn.className = 'btn btn-primary btn-record';
    playIcon.style.display = 'block';
    stopIcon.style.display = 'none';
    btnText.innerText = 'Bắt đầu';
    logoDot.classList.remove('listening');
    if (liveBadge) { liveBadge.textContent = 'Offline'; liveBadge.classList.remove('live'); }
    const footer = document.querySelector('.footer-status'); if (footer) footer.classList.remove('live');
    toggleBtn.setAttribute('aria-label', 'Bắt đầu ghi âm');
  }
}

// Clear all transcript lists and logs
function clearContent() {
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
  
  if (englishLog) englishLog.innerHTML = '';
  if (englishInterim) englishInterim.innerText = '';
  if (vietnameseLog) vietnameseLog.innerHTML = '';
  if (vietnameseInterim) vietnameseInterim.innerText = '';
  if (transcriptFeed) transcriptFeed.innerHTML = '';
  if (interimBlock) interimBlock.style.display = 'none';
  if (combinedPlaceholder) combinedPlaceholder.style.display = 'flex';
  selectedQuestionIdx = null;
  updateWordCounts();
  updateDock();
  
  // Clear summary output
  summaryPlaceholder.style.display = 'flex';
  summaryMarkdown.style.display = 'none';
  summaryMarkdown.innerHTML = '';
  summaryMarkdown.removeAttribute('data-raw-text');
  copySummaryBtn.style.display = 'none';
  
  showPlaceholders();
  showStatus('Đã xóa lịch sử');
  setTimeout(() => {
    if (isListening) {
      if (activeAudioTrack) {
        showStatus('Đang dịch âm thanh Tab...');
      } else {
        showStatus('Đang nghe tiếng Anh (Mic)...');
      }
    } else {
      showStatus('Sẵn sàng');
    }
  }, 1000);
}

// SETUP & GEMINI INTEGRATION LOGIC

// Setup Tab Switching Navigation
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

// Setup Settings Modal Overlay (Custom Provider)
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

    if (!baseUrl) { showToast('Vui lòng nhập Base URL', 'error'); baseUrlInput && baseUrlInput.focus(); return; }
    try { new URL(baseUrl); } catch { showToast('Base URL không hợp lệ', 'error'); return; }
    if (!model) { showToast('Vui lòng nhập Model', 'error'); modelInput && modelInput.focus(); return; }
    // API key có thể trống cho Ollama local, nhưng cảnh báo nếu trống với remote
    const isLocal = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');
    if (!key && !isLocal) { showToast('Vui lòng nhập API Key (hoặc dùng localhost)', 'error'); apiKeyInput.focus(); return; }

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
      showStatus('Đã lưu cấu hình Provider');
      showToast('Đã lưu cấu hình Provider', 'success');
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
    alert('Không có nội dung cuộc họp để tóm tắt. Vui lòng ghi âm trước.');
    return;
  }
  // provider validation
  if (!providerConfig.baseUrl || !providerConfig.model) {
    if (baseUrlInput) baseUrlInput.value = providerConfig.baseUrl || '';
    if (modelInput) modelInput.value = providerConfig.model || '';
    settingsOverlay.style.display = 'flex';
    alert('Vui lòng cấu hình Base URL và Model.');
    return;
  }
  const isLocal = providerConfig.baseUrl.includes('localhost') || providerConfig.baseUrl.includes('127.0.0.1');
  if (!providerConfig.apiKey && !isLocal) {
    if (apiKeyInput) apiKeyInput.value = '';
    settingsOverlay.style.display = 'flex';
    alert('Vui lòng nhập API Key.');
    return;
  }

  // Show loading
  summaryPlaceholder.style.display = 'none';
  summaryMarkdown.style.display = 'none';
  summaryLoading.style.display = 'flex';
  copySummaryBtn.style.display = 'none';
  // update loading text with provider
  const loadingP = summaryLoading.querySelector('p');
  if (loadingP) loadingP.textContent = `Đang phân tích bằng ${providerConfig.model}…`;

  const lang = summaryLangSelect.value;
  const detail = summaryDetailSelect.value;

  let prompt = '';
  if (lang === 'vi') {
    prompt = `Bạn là một trợ lý AI ghi chép và tóm tắt cuộc họp chuyên nghiệp. Dưới đây là biên bản ghi âm cuộc họp (transcript) bằng tiếng Anh:\n\n`;
    prompt += `"""\n${englishText}\n"""\n\n`;
    prompt += `Hãy tạo một bản tóm tắt cuộc họp bằng **Tiếng Việt** dựa trên các yêu cầu sau:\n`;
    if (detail === 'bullets') {
      prompt += `- Định dạng dưới dạng các gạch đầu dòng chi tiết chia theo từng chủ đề hoặc phần chính của cuộc họp.\n`;
      prompt += `- Nêu rõ các ý kiến phát biểu quan trọng.\n`;
    } else if (detail === 'short') {
      prompt += `- Viết một bản tóm tắt cực kỳ ngắn gọn, cô đọng (tối đa 2-3 đoạn văn ngắn) về nội dung chính bàn luận và kết luận chung.\n`;
    } else if (detail === 'action') {
      prompt += `- Liệt kê các công việc cần làm (Action Items), ai chịu trách nhiệm (nếu có đề cập), và thời hạn (nếu có).\n`;
      prompt += `- Phân chia danh sách một cách rõ ràng dưới dạng checkbox hoặc danh sách việc cần làm.\n`;
    }
    prompt += `- Định dạng đầu ra bằng Markdown sạch sẽ, sử dụng tiêu đề (h2, h3), chữ in đậm để làm nổi bật các từ khóa hoặc thông tin quan trọng. Không sử dụng HTML.`;
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
      // nếu baseUrl custom nhưng vẫn dạng Gemini, vẫn dùng key query
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

    if (!candidateText) throw new Error('API không trả về nội dung.');

    const renderedHtml = parseMarkdown(candidateText);
    summaryMarkdown.innerHTML = renderedHtml;
    summaryMarkdown.dataset.rawText = candidateText;
    summaryLoading.style.display = 'none';
    summaryMarkdown.style.display = 'block';
    copySummaryBtn.style.display = 'flex';
    showStatus('Tạo tóm tắt thành công');
    showToast(`Tóm tắt bằng ${model} thành công`, 'success');
  } catch (error) {
    console.error('Provider error:', error);
    summaryLoading.style.display = 'none';
    summaryPlaceholder.style.display = 'flex';
    summaryPlaceholder.innerHTML = `<span style="color: #ef4444;">⚠️ Lỗi khi tạo tóm tắt (${escapeHtml(providerConfig.baseUrl)}): ${escapeHtml(error.message)}. Kiểm tra Base URL / Model / API Key.</span>`;
    showStatus('Lỗi tạo tóm tắt');
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

// Show extension status bar message
function showStatus(msg) {
  if (!statusText) return;
  // statusText contains dot + span, preserve structure if exists
  const span = statusText.querySelector('span:last-child');
  if (span) span.innerText = msg;
  else statusText.innerText = msg;
}

function updateWordCounts() {
  const enText = finalizedEnPhrases.join(' ').trim();
  const viText = finalizedViPhrases.join(' ').trim();
  const enCount = enText ? enText.split(/\s+/).length : 0;
  const viCount = viText ? viText.split(/\s+/).length : 0;
  const total = enCount + viCount;
  if (enWordCount) enWordCount.textContent = enCount + ' từ';
  if (viWordCount) viWordCount.textContent = viCount + ' từ';
  if (combinedWordCount) combinedWordCount.textContent = total ? `${enCount} EN • ${viCount} VI` : '0 từ';
}

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

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.target.matches('input, textarea, select')) {
      e.preventDefault();
      toggleListening();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      clearContent();
      showToast('Đã xóa lịch sử', 'success');
    }
    if (e.key === 'Escape') {
      if (settingsOverlay) settingsOverlay.style.display = 'none';
      if (permissionOverlay) permissionOverlay.style.display = 'none';
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

// Helper to get all combined English text
function getFullEnglishText() {
  const final = finalizedEnPhrases.filter(Boolean).join(' ');
  return final.trim();
}

// Helper to get all combined Vietnamese text
function getFullVietnameseText() {
  const final = finalizedViPhrases.filter(v => v && v !== '…' && v !== '[Không thể dịch]').join(' ');
  return final.trim();
}

// Copy to Clipboard utility
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
    showToast('Đã sao chép vào clipboard', 'success');
    setTimeout(() => {
      button.innerHTML = originalHTML;
    }, 1500);
  } catch (err) {
    console.error('Failed to copy:', err);
    showToast('Sao chép thất bại', 'error');
  }
}
