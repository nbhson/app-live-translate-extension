import { CONFIG } from '../../config.js';
import { translateText } from './translate.js';

export async function translateBatchConcurrent(tasks, opts = {}) {
  const { concurrency = CONFIG.MAX_CONCURRENT_TRANSLATE, cache, controllers, setViText, scheduleWordCountUpdate, finalizedViPhrases, signal } = opts;
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const conc = Math.max(1, Math.min(concurrency, tasks.length, 5));
  const results = new Array(tasks.length);
  let next = 0;
  let failed = 0;
  async function worker() {
    while (true) {
      if (signal?.aborted) break;
      const cur = next++; if (cur >= tasks.length) break;
      const t = tasks[cur];
      if (!t || typeof t.text !== 'string' || !t.text.trim()) { results[cur] = ''; continue; }
      if (finalizedViPhrases?.[t.idx] && finalizedViPhrases[t.idx] !== '…' && finalizedViPhrases[t.idx] !== '[Translation failed]') { results[cur] = finalizedViPhrases[t.idx]; continue; }
      try {
        const out = await translateText(t.text, { cache, controllers, signal });
        if (signal?.aborted) { results[cur] = ''; break; }
        const val = out || '[Translation failed]';
        if (!out) failed++;
        results[cur] = val;
        if (finalizedViPhrases) finalizedViPhrases[t.idx] = val;
        if (t.cache) {
          if (setViText) setViText(t.cache.viText, val);
          if (t.cache.copyVi) { t.cache.copyVi.dataset.text = val; t.cache.copyVi.disabled = val === '[Translation failed]'; }
          if (t.cache.colVi && val !== '[Translation failed]') { t.cache.colVi.classList.add('vi-just-arrived'); setTimeout(() => t.cache.colVi.classList.remove('vi-just-arrived'), 800); }
        }
        if (scheduleWordCountUpdate) scheduleWordCountUpdate();
      } catch (e) {
        if (e.name === 'AbortError') { results[cur] = ''; break; }
        failed++;
        results[cur] = '[Translation failed]';
        if (finalizedViPhrases) finalizedViPhrases[cur] = '[Translation failed]';
      }
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  // expose failed count for caller telemetry (non-breaking)
  results.failed = failed;
  return results;
}
