import { CONFIG } from '../../config.js';
import { callProviderGeneric } from './provider.js';
import { storageSet } from '../storage.js';
import { createCompressionAgent } from '../../harness/agent/compression.agent.js';
import { isValidCompressSummary } from '../../utils/buildCompressPrompt.js';

export function createCompressService(store, deps) {
  const { showStatus, showToast, updateCompressToggleUI, isListening, activeAudioTrack } = deps;
  return {
    async perform(isManual = false) {
      const s0 = store.getState();
      if (s0.compressInProgress) return;
      if (!s0.compressEnabled && !isManual) return;
      const { providerConfig } = s0;
      const isLocal = String(providerConfig.baseUrl).includes('localhost') || String(providerConfig.baseUrl).includes('127.0.0.1');
      if (!providerConfig.baseUrl || !providerConfig.model || (!providerConfig.apiKey && !isLocal)) {
        if (isManual) showToast('AI Provider not configured for compression', 'error');
        return;
      }
      const pending = s0.finalizedEnPhrases.length - s0.lastCompressedIdx;
      if (pending < 2) { if (isManual) showToast('Not enough sentences to compress', 'default'); return; }
      // cap segment to avoid prompt too large: keep last ~8000 chars + truncate oldest
      let segmentSlice = s0.finalizedEnPhrases.slice(s0.lastCompressedIdx);
      let segment = segmentSlice.join('\n');
      if (segment.length > 8000) segment = segment.slice(-8000);
      if (!segment.trim()) return;
      // dedupe: if segment is mostly whitespace/punct, skip
      if (segment.trim().length < 10) return;
      store.setState({ compressInProgress: true });
      showStatus('Compressing history… (agent)');
      try {
        // Agent path (LLM + harness tools) — QA-aware compression, no loop needed for this task
        let summary;
        try {
          const agent = createCompressionAgent({ store, llmHarness: null });
          // use store-provided llm if available via harness, else direct provider with shared isValid
          summary = await agent.run({ segment, pendingCount: pending, providerConfig });
          if (!isValidCompressSummary(summary)) throw new Error('Agent returned invalid summary');
        } catch (agentErr) {
          console.warn('[compress agent fallback]', agentErr.message);
          // Fallback to original single-shot prompt if agent fails — also validated
          const prompt = `Summarize this conversation segment concisely. Keep key facts, names, topics, questions, decisions, and any context needed to answer future questions. Output 3-5 bullet points, max 150 words, in English. No extra intro.\n\nSegment:\n"""${segment}"""`;
          summary = await callProviderGeneric(prompt, providerConfig, { temperature: 0.3, maxTokens: 300, systemPrompt: 'You are a concise meeting summarizer. Output only bullet points.' });
          if (!isValidCompressSummary(summary)) throw new Error('Fallback summary invalid');
        }
        const clean = String(summary || '').trim();
        if (!clean) {
          if (isManual) showToast('Compression returned empty', 'error');
          return;
        }
        const s = store.getState();
        const header = `\n[+${pending} utterances @ ${new Date().toLocaleTimeString()}]`;
        let compressedSummary = (s.compressedSummary ? s.compressedSummary + header + '\n' : '') + clean;
        if (compressedSummary.length > 6000) compressedSummary = compressedSummary.slice(-6000);
        const lastCompressedIdx = s.finalizedEnPhrases.length;
        store.setState({ compressedSummary, lastCompressedIdx });
        await storageSet({ compressedSummary, lastCompressedIdx });
        updateCompressToggleUI();
        if (isManual) showToast(`Compressed ${pending} sentences`, 'success');
        else console.log('[compress] compressed', pending, '->', clean.slice(0,60));
      } catch (e) { console.warn('[compress]', e); if (isManual) showToast('Compression failed: ' + (e.message || e), 'error'); else showToast('Auto compress failed: ' + (e.message || e), 'error'); }
      finally {
        store.setState({ compressInProgress: false });
        const st = store.getState();
        showStatus(st.isListening ? (st.activeAudioTrack ? 'Translating Tab audio...' : 'Listening for English (Mic)...') : 'Ready');
      }
    },
    start() {
      const s = store.getState();
      if (s.compressTimer) clearInterval(s.compressTimer);
      if (!s.compressEnabled) return;
      const t = setInterval(() => this.perform(false), CONFIG.COMPRESS_INTERVAL_MS);
      store.setState({ compressTimer: t });
    },
    stop() {
      const t = store.getState().compressTimer;
      if (t) clearInterval(t);
      store.setState({ compressTimer: null });
    },
  };
}
