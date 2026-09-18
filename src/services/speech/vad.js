/**
 * VAD service — pure centroid + toggle, monitor lifecycle
 * @module services/speech/vad
 */
import { CONFIG } from '../../config.js';
import { computeSpectralCentroid } from '../../utils/computeSpectralCentroid.js';
import { shouldToggleSpeaker as pureToggle } from '../../utils/shouldToggleSpeaker.js';

export { computeSpectralCentroid };

export function shouldToggleSpeaker(feats, pauseLen, lastFeatures, lastSwitchAt, now) {
  return pureToggle(feats, pauseLen, lastFeatures, lastSwitchAt, now, CONFIG.SPEAKER_CENTROID_DIFF);
}

export function createVadMonitor(store, actions) {
  return {
    setup(stream) {
      if (!stream || typeof stream.getAudioTracks !== 'function') { console.warn('[vad] invalid stream'); return; }
      // ignore setup if user explicitly disabled? keep but avoid double
      const existing = store.getState().speakerMonitor;
      if (existing && existing.stream === stream) return;
      actions.teardownSpeakerMonitor();
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
        const monitor = { ctx, analyser, dataFreq, dataTime, stream, timer: null, lastRms: 0, lastCentroid: 0, speechStartAt: 0, tickCount: 0 };
        store.setState({ speakerMonitor: monitor, speakerVadState: 'silence', speakerVadSilenceMs: 0 });
        let lastTick = performance.now();
        const tick = () => {
          const now = performance.now(); const dt = now - lastTick; lastTick = now;
          // if document hidden, pause vad to save CPU
          if (typeof document !== 'undefined' && document.hidden) return;
          // check stream still alive
          const st = store.getState();
          if (!st.speakerMonitor || st.speakerMonitor.stream !== stream) return;
          analyser.getByteTimeDomainData(dataTime); analyser.getByteFrequencyData(dataFreq);
          let sum = 0; for (let i = 0; i < dataTime.length; i++) { const v = (dataTime[i] - 128) / 128; sum += v * v; }
          const rms = Math.sqrt(sum / dataTime.length);
          const centroid = computeSpectralCentroid(dataFreq, ctx.sampleRate);
          // hysteresis: need min speech duration to count as speech (filter clicks)
          const isSpeechRaw = rms > CONFIG.SPEAKER_VAD_RMS_THRESH;
          const s = store.getState();
          monitor.tickCount++;
          // adaptive: ignore very high centroid > 6000 (often noise)
          const isNoise = centroid > 6500 && rms < 0.08;
          const isSpeech = isSpeechRaw && !isNoise;
          if (isSpeech) {
            if (s.speakerVadState === 'silence') {
              const pauseLen = s.speakerVadSilenceMs;
              store.setState({ speakerVadState: 'speech' });
              if (monitor) monitor.speechStartAt = now;
              if (pauseLen >= CONFIG.SPEAKER_MIN_PAUSE_MS && s.lastSpeakerFeatures) {
                const feats = { rms, centroid };
                const { shouldToggle, newSwitchAt } = pureToggle(feats, pauseLen, s.lastSpeakerFeatures, s.speakerVadLastSwitchAt, now, CONFIG.SPEAKER_CENTROID_DIFF);
                if (shouldToggle) { store.setState({ currentSpeakerId: (s.currentSpeakerId + 1) % 2, speakerVadLastSwitchAt: newSwitchAt }); actions.maybeCutLiveOnSpeakerChange(); }
                store.setState({ lastSpeakerFeatures: feats });
              } else if (!s.lastSpeakerFeatures) store.setState({ lastSpeakerFeatures: { rms, centroid } });
              // else keep existing features, but still update on next ticks
            } else if (s.lastSpeakerFeatures) {
              // exponential moving average to smooth features
              const lf = s.lastSpeakerFeatures;
              const alpha = 0.15;
              store.setState({ lastSpeakerFeatures: { rms: lf.rms * (1-alpha) + rms * alpha, centroid: lf.centroid * (1-alpha) + centroid * alpha } });
            }
            store.setState({ speakerVadSilenceMs: 0 });
          } else {
            if (s.speakerVadState === 'speech') {
              // require min speech duration before switching to silence (debounce short gaps)
              const speechDur = monitor.speechStartAt ? now - monitor.speechStartAt : 0;
              if (speechDur < CONFIG.SPEAKER_MIN_SPEECH_MS && isSpeechRaw === false) {
                // keep as speech briefly
              } else store.setState({ speakerVadState: 'silence' });
            }
            store.setState({ speakerVadSilenceMs: s.speakerVadSilenceMs + dt });
          }
          const m = store.getState().speakerMonitor;
          if (m) { m.lastRms = rms; m.lastCentroid = centroid; }
        };
        monitor.timer = setInterval(tick, 120);
        // pause when tab hidden to save CPU
        const onVis = () => { if (document.hidden && monitor.timer) { clearInterval(monitor.timer); monitor.timer = null; } else if (!document.hidden && !monitor.timer) monitor.timer = setInterval(tick, 120); };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis, { once: false });
        monitor._visHandler = onVis;
      } catch (e) { console.warn('[vad.setup]', e); }
    },
    teardown() {
      const m = store.getState().speakerMonitor;
      if (m?.timer) { clearInterval(m.timer); m.timer = null; }
      if (m?._visHandler && typeof document !== 'undefined') try { document.removeEventListener('visibilitychange', m._visHandler); } catch {}
      if (m?.ctx && m.ctx.state === 'running') { try { void m.ctx.suspend(); } catch {} }
      // also disconnect analyser source if possible
      store.setState({ speakerMonitor: null, speakerVadState: 'silence', speakerVadSilenceMs: 0 });
    },
  };
}
