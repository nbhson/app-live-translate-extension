import { CONFIG } from '../../config.js';

const TRANSLATE_MAX_CHARS = 4200;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function chunkBySentence(text, maxLen) {
  if (text.length <= maxLen) return [text];
  // split on sentence boundaries (keep delimiter)
  const parts = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + ' ' + p).trim().length > maxLen) {
      if (cur) chunks.push(cur.trim());
      // if single part itself too long, force split by maxLen
      if (p.length > maxLen) {
        for (let i = 0; i < p.length; i += maxLen) chunks.push(p.slice(i, i + maxLen));
        cur = '';
      } else cur = p;
    } else cur = cur ? cur + ' ' + p : p;
  }
  if (cur) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

/**
 * Translate EN→VI via Google free API — abortable, cached, validated, chunked, retryable
 * @param {string} text
 * @param {{ signal?: AbortSignal, cache?: any, controllers?: Set<AbortController>, retries?: number }} opts
 * @returns {Promise<string>}
 */
export async function translateText(text, opts = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  const cache = opts.cache;
  // LRU touch
  if (cache?.has(trimmed)) return cache.get(trimmed);

  // Chunk long text to avoid URL length / 5000 limit
  if (trimmed.length > TRANSLATE_MAX_CHARS) {
    const chunks = chunkBySentence(trimmed, TRANSLATE_MAX_CHARS);
    if (chunks.length > 1) {
      const outs = [];
      for (const c of chunks) {
        if (opts.signal?.aborted) return '';
        const r = await translateText(c, opts);
        outs.push(r || c);
      }
      const joined = outs.join(' ');
      if (joined && cache) cache.set(trimmed, joined);
      return joined;
    }
  }

  const controllers = opts.controllers;
  const retries = opts.retries ?? 2;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const signal = opts.signal || controller.signal;
    if (!opts.signal && controllers) controllers.add(controller);
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.TRANSLATE_TIMEOUT_MS);
    // link external abort to inner controller when we own it
    let abortHandler = null;
    if (opts.signal && opts.signal !== controller.signal) {
      abortHandler = () => controller.abort();
      opts.signal.addEventListener('abort', abortHandler, { once: true });
    }
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=${encodeURIComponent(trimmed)}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const status = res.status;
        if (RETRYABLE_STATUS.has(status) && attempt < retries) {
          let delay = Math.pow(2, attempt) * 400 + Math.random() * 200;
          // honor Retry-After if present
          try { const ra = res.headers.get('Retry-After'); if (ra) delay = Math.max(delay, parseInt(ra, 10) * 1000); } catch {}
          await sleep(delay, opts.signal);
          continue;
        }
        throw new Error(`HTTP ${status}`);
      }
      const data = await res.json();
      let out = '';
      if (data?.[0]) for (let i = 0; i < data[0].length; i++) if (data[0][i]?.[0]) out += data[0][i][0];
      out = String(out || '').trim();
      // empty out is retryable once (often transient)
      if (!out && attempt < retries && trimmed.length > 3) {
        await sleep(300 * (attempt+1), opts.signal);
        continue;
      }
      if (out && cache) cache.set(trimmed, out);
      return out;
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError') return '';
      const isRetryable = e.message && (e.message.includes('Failed to fetch') || e.message.includes('NetworkError'));
      if (isRetryable && attempt < retries) {
        await sleep(Math.pow(2, attempt) * 350 + Math.random()*150, opts.signal).catch(()=>{});
        continue;
      }
      if (attempt >= retries) {
        console.error('[translateText]', e);
        return '';
      }
      // otherwise retry
      await sleep(Math.pow(2, attempt) * 300, opts.signal).catch(()=>{});
    } finally {
      clearTimeout(timeoutId);
      if (abortHandler && opts.signal) try { opts.signal.removeEventListener('abort', abortHandler); } catch {}
      if (controllers) controllers.delete(controller);
    }
  }
  if (lastErr) console.error('[translateText] exhausted', lastErr);
  return '';
}

export function abortAll(controllers) {
  for (const c of controllers) try { c.abort(); } catch {}
  controllers.clear();
}

export const _internals = { chunkBySentence, RETRYABLE_STATUS, TRANSLATE_MAX_CHARS };
