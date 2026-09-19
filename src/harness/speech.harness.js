/**
 * Speech Harness — wraps Web Speech API behind injectable adapter.
 * Re-uses pure parseRecognitionEvent from src/services/speech/recognition.
 * @module harness/speech.harness
 */
import { CONFIG } from '../config.js';
import { parseRecognitionEvent as pureParse } from '../services/speech/recognition.js';

export { pureParse as parseRecognitionEvent };

export function createSpeechHarness({ store, windowApi, actions } = {}) {
  const _win = windowApi ?? (typeof window !== 'undefined' ? window : globalThis);

  return {
    parseRecognitionEvent: pureParse,

    createRecognition() {
      const SR = _win.SpeechRecognition || _win.webkitSpeechRecognition;
      if (!SR) return null;
      const rec = new SR();
      rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
      return rec;
    },

    attachHandlers(rec, storeRef, act) {
      const a = act || actions;
      const s = storeRef || store;
      if (!rec || !a || !s) return;
      rec.onstart = () => {
        s.setState({ isListening: true });
        a.updateUIForListening?.(true);
        a.showStatus?.(s.getState().activeAudioTrack ? 'Translating Tab audio...' : 'Listening for English (Mic)...');
        if (s.getState().compressEnabled) a.startCompressTimer?.();
      };
      rec.onresult = (event) => {
        const cur = s.getState();
        if (cur.silenceTimer) { clearTimeout(cur.silenceTimer); s.setState({ silenceTimer: null }); }
        const { interimEn, finals, nextLastFinalIndex, nextOffset } = pureParse(event, cur);
        s.setState({ lastFinalIndex: nextLastFinalIndex, finalizedOffset: nextOffset });
        for (const f of finals) a.finalizeText?.(f).catch(() => {});
        if (!interimEn) return;
        a.hidePlaceholders?.();
        const liveCache = a.ensureLiveUtterance?.();
        if (liveCache?.enText && liveCache.enText.textContent !== interimEn) {
          liveCache.enText.textContent = interimEn;
          liveCache.enText.classList.add('typing');
        }
        a.autoScroll?.(false, 'instant');
        a.debouncedTranslateInterim?.(interimEn);
        const lastIdx = event.results.length - 1;
        const curLen = event.results[lastIdx] ? String(event.results[lastIdx][0].transcript || '').length : interimEn.length;
        if (interimEn.length >= CONFIG.MAX_INTERIM_LENGTH) a.forceFinalizeText?.(interimEn, curLen).catch(() => {});
        else {
          const t = setTimeout(() => a.forceFinalizeText?.(interimEn, curLen).catch(() => {}), CONFIG.SILENCE_THRESHOLD);
          s.setState({ silenceTimer: t });
        }
      };
      rec.onerror = (event) => {
        const err = event?.error ? String(event.error) : 'unknown';
        console.error('[SpeechHarness.onerror]', err);
        if (err === 'not-allowed' || err === 'service-not-allowed') { a.showPermissionOverlay?.(); a.stopListening?.(); }
        else if (err === 'no-speech' || err === 'aborted') { /* ignore */ }
        else if (err === 'audio-capture') { a.showToast?.('Mic not found — check device', 'error'); a.showStatus?.('Mic error'); a.stopListening?.(); }
        else if (err === 'network') { a.showToast?.('STT network error — retrying', 'error'); a.showStatus?.('STT network error'); }
        else { a.showStatus?.(`Error: ${err}`); a.showToast?.(`Recording error: ${err}`, 'error'); a.stopListening?.(); }
      };
      rec.onend = () => {
        const cur = s.getState();
        if (cur.isListening) {
          try {
            s.setState({ lastFinalIndex: -1, finalizedOffset: 0 });
            const r = s.getState().recognition; if (!r) throw new Error('no rec');
            setTimeout(() => {
              const fresh = s.getState();
              if (!fresh.isListening) return;
              const rr = fresh.recognition;
              if (!rr) return;
              try { if (fresh.activeAudioTrack) rr.start(fresh.activeAudioTrack); else rr.start(); }
              catch (e) { console.error('[SpeechHarness auto-restart]', e); a.showToast?.('Auto-restart failed', 'error'); a.stopListening?.(); }
            }, 300);
          } catch (e) { console.error('[SpeechHarness onend]', e); a.showToast?.('Auto-restart failed', 'error'); }
        } else a.updateUIForListening?.(false);
      };
    },
  };
}
