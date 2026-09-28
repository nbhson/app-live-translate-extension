/**
 * Fallback translation providers — pure, testable, no chrome imports.
 * Chain: Google (primary, in translate.js) -> MyMemory -> Lingva -> AI provider
 * @module services/translate/providers
 */

export const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';
export const LINGVA_ENDPOINTS = Object.freeze([
  'https://lingva.ml/api/v1/en/vi',
  'https://lingva.thedaviddelta.com/api/v1/en/vi',
]);
export const MYMEMORY_MAX_CHARS = 450;

function fetchWithTimeoutJson(url, { signal, timeoutMs = 8000, fetchFn = fetch } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs);
  let onAbort = null;
  if (signal) {
    if (signal.aborted) {
      clearTimeout(t);
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    onAbort = () => { try { ctrl.abort(); } catch {} };
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return fetchFn(url, { signal: ctrl.signal })
    .finally(() => {
      clearTimeout(t);
      if (signal && onAbort) try { signal.removeEventListener('abort', onAbort); } catch {}
    });
}

function chunkForMyMemory(text, maxLen = MYMEMORY_MAX_CHARS) {
  const s = String(text || '');
  if (s.length <= maxLen) return [s];
  const parts = s.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + ' ' + p).trim().length > maxLen) {
      if (cur) chunks.push(cur.trim());
      if (p.length > maxLen) {
        for (let i = 0; i < p.length; i += maxLen) chunks.push(p.slice(i, i + maxLen));
        cur = '';
      } else cur = p;
    } else cur = cur ? `${cur} ${p}` : p;
  }
  if (cur) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

/**
 * MyMemory free API — no key, CORS open.
 * Quota: ~500 bytes/req, ~5000 chars/day/IP. Returns '' on quota/error.
 */
export async function translateViaMyMemory(text, opts = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (opts.signal?.aborted) return '';
  const fetchFn = opts.fetchFn || fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const chunks = chunkForMyMemory(trimmed, opts.maxChars ?? MYMEMORY_MAX_CHARS);
  const outs = [];
  for (const c of chunks) {
    if (opts.signal?.aborted) return '';
    const url = `${MYMEMORY_ENDPOINT}?q=${encodeURIComponent(c)}&langpair=en|vi`;
    let res;
    try {
      res = await fetchWithTimeoutJson(url, { signal: opts.signal, timeoutMs, fetchFn });
    } catch (e) {
      if (e?.name === 'AbortError') return '';
      return '';
    }
    if (!res?.ok) return '';
    let data;
    try {
      data = await res.json();
    } catch { return ''; }
    const translated = String(data?.responseData?.translatedText || '').trim();
    const status = data?.responseStatus;
    // MyMemory quota exceeded -> responseStatus 429 / 403 or WARNING text
    if (/MYMEMORY WARNING/i.test(translated)) return '';
    if (status !== undefined && String(status) !== '200' && String(status) !== '201') {
      // 200 = TM match, allow fallback to MT field? keep strict: need translated text
      if (!translated) return '';
    }
    if (!translated) return '';
    // MyMemory echoes input when it has no translation — treat identical echo as fail
    // (only for longer texts to avoid false negatives on proper nouns)
    if (translated.toLowerCase() === c.toLowerCase() && c.length > 15) return '';
    outs.push(translated);
  }
  return outs.join(' ').trim();
}

/**
 * Lingva Translate — free Google scraper, no key.
 * Tries multiple public instances in order.
 */
export async function translateViaLingva(text, opts = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (opts.signal?.aborted) return '';
  // Lingva path param has URL length limits — cap ~2000 chars per request
  if (trimmed.length > 2000) return '';
  const fetchFn = opts.fetchFn || fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const endpoints = opts.endpoints || LINGVA_ENDPOINTS;
  for (const base of endpoints) {
    if (opts.signal?.aborted) return '';
    const url = `${String(base).replace(/\/+$/, '')}/${encodeURIComponent(trimmed)}`;
    let res;
    try {
      res = await fetchWithTimeoutJson(url, { signal: opts.signal, timeoutMs, fetchFn });
    } catch (e) {
      if (e?.name === 'AbortError') return '';
      continue; // try next instance
    }
    if (!res?.ok) continue;
    try {
      const data = await res.json();
      const out = String(data?.translation || '').trim();
      if (out) return out;
    } catch { /* try next */ }
  }
  return '';
}

export function isValidAiProviderConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const base = String(cfg.baseUrl || '').trim();
  const model = String(cfg.model || '').trim();
  if (!/^https?:\/\/.+/.test(base) || !model) return false;
  const isLocal = base.includes('localhost') || base.includes('127.0.0.1');
  if (!cfg.apiKey && !isLocal) return false;
  return true;
}

export function buildAiTranslatePrompt(text) {
  return `Translate the following English text to Vietnamese. Output ONLY the Vietnamese translation, no explanation, no quotes, no romanization.\n\nEnglish: ${String(text || '').trim()}`;
}

/**
 * AI provider fallback — uses already-configured Gemini/OpenAI/Groq/Ollama.
 * callGeneric signature matches src/services/llm/provider.js:
 *   callGeneric(prompt, providerConfig, { temperature, maxTokens, timeout, signal })
 */
export async function translateViaAI(text, providerConfig, callGeneric, opts = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (opts.signal?.aborted) return '';
  if (!isValidAiProviderConfig(providerConfig)) return '';
  if (typeof callGeneric !== 'function') return '';
  try {
    const raw = await callGeneric(buildAiTranslatePrompt(trimmed), providerConfig, {
      temperature: 0.1,
      maxTokens: opts.maxTokens ?? 512,
      timeout: opts.timeoutMs ?? 15000,
      systemPrompt: 'You are a precise English to Vietnamese translator. Return only the translation.',
      signal: opts.signal,
    });
    const out = String(raw || '').trim().replace(/^["'“”`]+|["'“”`]+$/g, '').trim();
    if (!out) return '';
    if (out.toLowerCase() === trimmed.toLowerCase() && trimmed.length > 15) return '';
    return out;
  } catch (e) {
    if (e?.name === 'AbortError') return '';
    return '';
  }
}

/**
 * Full fallback chain after Google fails.
 * Order: mymemory -> lingva -> ai. Returns { text, via }.
 */
export async function translateWithFallbackChain(text, opts = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { text: '', via: 'none' };
  if (opts.signal?.aborted) return { text: '', via: 'aborted' };
  const order = opts.order || ['mymemory', 'lingva', 'ai'];
  for (const name of order) {
    if (opts.signal?.aborted) return { text: '', via: 'aborted' };
    try {
      if (name === 'mymemory' && opts.disableMyMemory) continue;
      if (name === 'lingva' && opts.disableLingva) continue;
      if (name === 'ai' && opts.disableAI) continue;
      let out = '';
      if (name === 'mymemory') out = await translateViaMyMemory(trimmed, opts);
      else if (name === 'lingva') out = await translateViaLingva(trimmed, opts);
      else if (name === 'ai') out = await translateViaAI(trimmed, opts.providerConfig, opts.callGeneric, opts);
      if (out) {
        try { opts.onStep?.(name, out); } catch {}
        return { text: out, via: name };
      }
    } catch { /* next provider */ }
  }
  return { text: '', via: 'failed' };
}

export const _internals = { chunkForMyMemory, fetchWithTimeoutJson };
