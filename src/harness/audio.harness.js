/**
 * Audio Harness — wraps AudioContext/Analyser/VAD behind injectable adapter.
 * Delegates pure math to src/utils/computeSpectralCentroid & shouldToggleSpeaker.
 * @module harness/audio.harness
 */
import { CONFIG } from '../config.js';
import { computeSpectralCentroid as pureCentroid } from '../utils/computeSpectralCentroid.js';
import { shouldToggleSpeaker as pureToggle } from '../utils/shouldToggleSpeaker.js';

export { pureCentroid as computeSpectralCentroid };

export function createAudioHarness({ store, windowApi } = {}) {
  const _win = windowApi ?? (typeof window !== 'undefined' ? window : globalThis);

  return {
    computeSpectralCentroid: pureCentroid,

    shouldToggleSpeaker(feats, pauseLen, lastFeatures, lastSwitchAt, now) {
      return pureToggle(feats, pauseLen, lastFeatures, lastSwitchAt, now, CONFIG.SPEAKER_CENTROID_DIFF);
    },

    createMonitor(stream, callbacks = {}) {
      if (!stream || typeof stream.getAudioTracks !== 'function') { console.warn('[AudioHarness] invalid stream'); return null; }
      try {
        const AudioCtx = _win.AudioContext || _win.webkitAudioContext;
        const ctx = _win.capturedAudioContext || new AudioCtx();
        if (!_win.capturedAudioContext) _win.capturedAudioContext = ctx;
        if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.35;
        source.connect(analyser);
        const dataFreq = new Uint8Array(analyser.frequencyBinCount);
        const dataTime = new Uint8Array(analyser.fftSize);
        const monitor = { ctx, analyser, dataFreq, dataTime, stream, timer: null, lastRms: 0, lastCentroid: 0, speechStartAt: 0, tickCount: 0, _visHandler: null, source };
        return { ctx, analyser, dataFreq, dataTime, monitor, source };
      } catch (e) { console.warn('[AudioHarness.createMonitor]', e); return null; }
    },

    startVadLoop(monitorBundle, storeRef, callbacks = {}) {
      const { analyser, dataFreq, dataTime, monitor } = monitorBundle;
      const ctx = monitor.ctx;
      let lastTick = performance.now();
      const tick = () => {
        const now = performance.now();
        const dt = now - lastTick; lastTick = now;
        if (typeof document !== 'undefined' && document.hidden) { lastTick = now; return; }
        const st = storeRef.getState();
        if (!st.speakerMonitor || st.speakerMonitor.stream !== monitor.stream) return;
        analyser.getByteTimeDomainData(dataTime);
        analyser.getByteFrequencyData(dataFreq);
        let sum = 0; for (let i = 0; i < dataTime.length; i++) { const v = (dataTime[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / dataTime.length);
        const centroid = pureCentroid(dataFreq, ctx.sampleRate);
        const isNoise = centroid > 6500 && rms < 0.08;
        const isSpeech = rms > CONFIG.SPEAKER_VAD_RMS_THRESH && !isNoise;
        monitor.tickCount = (monitor.tickCount || 0) + 1;
        const s = storeRef.getState();
        if (isSpeech) {
          if (s.speakerVadState === 'silence') {
            const pauseLen = s.speakerVadSilenceMs;
            storeRef.setState({ speakerVadState: 'speech' });
            if (monitor) monitor.speechStartAt = now;
            if (pauseLen >= CONFIG.SPEAKER_MIN_PAUSE_MS && s.lastSpeakerFeatures) {
              const feats = { rms, centroid };
              const { shouldToggle, newSwitchAt } = pureToggle(feats, pauseLen, s.lastSpeakerFeatures, s.speakerVadLastSwitchAt, now, CONFIG.SPEAKER_CENTROID_DIFF);
              if (shouldToggle) { storeRef.setState({ currentSpeakerId: (s.currentSpeakerId + 1) % 2, speakerVadLastSwitchAt: newSwitchAt }); callbacks.onSpeakerToggle?.(); }
              storeRef.setState({ lastSpeakerFeatures: feats });
            } else if (!s.lastSpeakerFeatures) storeRef.setState({ lastSpeakerFeatures: { rms, centroid } });
          } else if (s.lastSpeakerFeatures) {
            const lf = s.lastSpeakerFeatures; const alpha = 0.15;
            storeRef.setState({ lastSpeakerFeatures: { rms: lf.rms * (1 - alpha) + rms * alpha, centroid: lf.centroid * (1 - alpha) + centroid * alpha } });
          }
          storeRef.setState({ speakerVadSilenceMs: 0 });
        } else {
          const cur = storeRef.getState();
          if (cur.speakerVadState === 'speech') {
            const speechDur = monitor.speechStartAt ? now - monitor.speechStartAt : 0;
            if (speechDur < CONFIG.SPEAKER_MIN_SPEECH_MS && rms <= CONFIG.SPEAKER_VAD_RMS_THRESH) { /* keep speech */ } else storeRef.setState({ speakerVadState: 'silence' });
          }
          storeRef.setState({ speakerVadSilenceMs: storeRef.getState().speakerVadSilenceMs + dt });
        }
        const m = storeRef.getState().speakerMonitor;
        if (m) { m.lastRms = rms; m.lastCentroid = centroid; }
      };
      monitor.timer = setInterval(tick, 120);
      const onVis = () => {
        if (typeof document !== 'undefined' && document.hidden && monitor.timer) { clearInterval(monitor.timer); monitor.timer = null; }
        else if (typeof document !== 'undefined' && !document.hidden && monitor && !monitor.timer) monitor.timer = setInterval(tick, 120);
      };
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
      monitor._visHandler = onVis;
      return monitor;
    },

    teardownMonitor(storeRef) {
      const m = storeRef.getState().speakerMonitor;
      if (m?.timer) { clearInterval(m.timer); m.timer = null; }
      if (m?._visHandler && typeof document !== 'undefined') try { document.removeEventListener('visibilitychange', m._visHandler); } catch {}
      if (m?.ctx && m.ctx.state === 'running') { try { void m.ctx.suspend(); } catch {} }
      storeRef.setState({ speakerMonitor: null, speakerVadState: 'silence', speakerVadSilenceMs: 0 });
    },
  };
}
