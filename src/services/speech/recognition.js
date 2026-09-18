/**
 * Speech recognition service — pure parse + handlers, no globals
 * @module services/speech/recognition
 */
import { CONFIG } from '../../config.js';

/**
 * Pure: extract finals + interim from SpeechRecognitionEvent
 * @param {SpeechRecognitionEvent} event
 * @param {{ lastFinalIndex: number, finalizedOffset: number }} ctx
 * @returns {{ interimEn: string, finals: string[], nextLastFinalIndex: number, nextOffset: number }}
 */
export function parseRecognitionEvent(event, ctx) {
  let interimEn = '';
  const finals = [];
  let nextLastFinalIndex = ctx.lastFinalIndex;
  let nextOffset = ctx.finalizedOffset;
  // guard malformed event
  if (!event || !event.results || typeof event.resultIndex !== 'number') {
    return { interimEn: '', finals: [], nextLastFinalIndex, nextOffset };
  }
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const r = event.results[i];
    if (!r || !r[0]) continue;
    const confidence = r[0].confidence;
    // ignore very low confidence finals (<0.25) to reduce hallucinations
    if (r.isFinal) {
      if (i > nextLastFinalIndex) {
        nextLastFinalIndex = i;
        const raw = String(r[0].transcript || '');
        // skip empty or only punctuation
        if (!raw.trim() || /^[\s\.\,\!\?\-]+$/.test(raw)) { nextOffset = 0; continue; }
        if (Number.isFinite(confidence) && confidence < 0.25) { nextOffset = 0; continue; }
        const remaining = raw.substring(nextOffset).trim();
        nextOffset = 0;
        // deduplicate adjacent identical finals (Chrome sometimes fires duplicate)
        if (remaining && finals[finals.length-1] !== remaining) finals.push(remaining);
      }
    } else {
      const raw = String(r[0].transcript || '');
      if (nextOffset > raw.length) nextOffset = raw.length;
      interimEn = raw.substring(nextOffset).trim();
      // sanitize interim: remove excessive repeats (STT sometimes repeats)
      if (interimEn.length > 200) interimEn = interimEn.slice(-200);
    }
  }
  return { interimEn, finals, nextLastFinalIndex, nextOffset };
}

export function createRecognitionHandlers({ store, actions }) {
  return {
    onStart() {
      store.setState({ isListening: true });
      actions.updateUIForListening(true);
      actions.showStatus(store.getState().activeAudioTrack ? 'Translating Tab audio...' : 'Listening for English (Mic)...');
      if (store.getState().compressEnabled) actions.startCompressTimer();
    },
    onResult(event) {
      const s = store.getState();
      if (s.silenceTimer) { clearTimeout(s.silenceTimer); store.setState({ silenceTimer: null }); }
      const { interimEn, finals, nextLastFinalIndex, nextOffset } = parseRecognitionEvent(event, s);
      store.setState({ lastFinalIndex: nextLastFinalIndex, finalizedOffset: nextOffset });
      for (const f of finals) actions.finalizeText(f).catch(() => {});
      if (!interimEn) return;
      actions.hidePlaceholders();
      const liveCache = actions.ensureLiveUtterance();
      if (liveCache?.enText && liveCache.enText.textContent !== interimEn) {
        liveCache.enText.textContent = interimEn;
        liveCache.enText.classList.add('typing');
      }
      actions.autoScroll(false, 'instant');
      actions.debouncedTranslateInterim(interimEn);
      const lastIdx = event.results.length - 1;
      const curLen = event.results[lastIdx] ? String(event.results[lastIdx][0].transcript || '').length : interimEn.length;
      if (interimEn.length >= CONFIG.MAX_INTERIM_LENGTH) actions.forceFinalizeText(interimEn, curLen).catch(() => {});
      else {
        const t = setTimeout(() => actions.forceFinalizeText(interimEn, curLen).catch(() => {}), CONFIG.SILENCE_THRESHOLD);
        store.setState({ silenceTimer: t });
      }
    },
    onError(event) {
      const err = event && event.error ? String(event.error) : 'unknown';
      console.error('[recognition.error]', err);
      if (err === 'not-allowed' || err === 'service-not-allowed') { actions.showPermissionOverlay(); actions.stopListening(); }
      else if (err === 'no-speech' || err === 'aborted') { /* ignore, will restart via onEnd */ }
      else if (err === 'audio-capture') { actions.showToast('Mic not found — check device', 'error'); actions.showStatus('Mic error'); actions.stopListening(); }
      else if (err === 'network') { actions.showToast('STT network error — retrying', 'error'); actions.showStatus('STT network error'); /* don't stop, let onEnd retry */ }
      else { actions.showStatus(`Error: ${err}`); actions.showToast(`Recording error: ${err}`, 'error'); actions.stopListening(); }
    },
    onEnd() {
      const s = store.getState();
      if (s.isListening) {
        // exponential backoff for auto-restart to avoid tight loop on network error
        const delay = 300;
        try {
          store.setState({ lastFinalIndex: -1, finalizedOffset: 0 });
          const rec = s.recognition;
          if (!rec) throw new Error('no recognition');
          const doStart = () => {
            try {
              if (s.activeAudioTrack) rec.start(s.activeAudioTrack);
              else rec.start();
            } catch (e) { console.error('[auto-restart]', e); actions.showToast('Auto-restart failed', 'error'); actions.stopListening(); }
          };
          if (delay > 0) setTimeout(doStart, delay);
          else doStart();
        } catch (e) { console.error('[auto-restart]', e); actions.showToast('Auto-restart failed', 'error'); }
      } else actions.updateUIForListening(false);
    },
  };
}

export function initRecognition(store, actions) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { actions.showStatus('Browser does not support Speech Recognition.'); actions.showToast('Browser does not support SpeechRecognition', 'error'); return null; }
  const rec = new SpeechRecognition();
  rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
  const h = createRecognitionHandlers({ store, actions });
  rec.onstart = h.onStart; rec.onresult = h.onResult; rec.onerror = h.onError; rec.onend = h.onEnd;
  store.setState({ recognition: rec });
  return rec;
}
