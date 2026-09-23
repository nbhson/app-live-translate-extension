/**
 * LLM provider — DRY, validated, abortable, retry 429
 * @module services/llm/provider
 */

function isGemini(baseUrl) { return String(baseUrl).includes('generativelanguage.googleapis.com'); }
export { isGemini };

export async function fetchWithTimeout(url, opts, timeout = 30000) {
  const ctrl = new AbortController();
  const signal = opts.signal;
  // link external abort
  let abortHandler = null;
  if (signal) {
    abortHandler = () => ctrl.abort();
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', abortHandler, { once: true });
  }
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
    if (signal && abortHandler) try { signal.removeEventListener('abort', abortHandler); } catch {}
  }
}

export async function fetchWithRetry(url, opts, timeout = 30000, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, opts, timeout);
      if (res.ok) return res;
      const status = res.status;
      const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
      if (retryable && attempt < maxRetries) {
        let delay = Math.pow(2, attempt) * 500 + Math.random() * 300;
        try { const ra = res.headers.get('Retry-After'); if (ra) delay = Math.max(delay, parseInt(ra,10)*1000); } catch {}
        // drain body to free connection
        try { await res.text(); } catch {}
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError') throw e;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt)*400));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('fetch failed');
}

export async function callProviderForSuggest(prompt, providerConfig, opts = {}) {
  const baseUrl = String(providerConfig.baseUrl || '').replace(/\/+$/, '');
  const model = String(providerConfig.model || '').trim();
  const apiKey = String(providerConfig.apiKey || '').trim();
  if (!baseUrl || !model) throw new Error('Missing baseUrl/model');
  const isLocal = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');
  if (!apiKey && !isLocal) throw new Error('Missing apiKey');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Empty prompt');
  const timeout = opts.timeout ?? 30000;
  const signal = opts.signal;

  if (isGemini(baseUrl)) {
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
    const res = await fetchWithRetry(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.8, maxOutputTokens: 1024 } }),
    }, timeout, 2);
    if (!res.ok) { let msg = `HTTP ${res.status}`; try { const d = await res.json(); msg = d.error?.message || msg; } catch {} throw new Error(msg); }
    const data = await res.json();
    const txt = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!txt) throw new Error('Empty LLM response');
    return txt;
  } else {
    const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetchWithRetry(url, {
      method: 'POST', headers, signal,
      body: JSON.stringify({
        model, messages: [
          { role: 'system', content: 'You output ONLY JSON object with "structures" and "answers" arrays. No markdown, no extra text.' },
          { role: 'user', content: prompt },
        ], temperature: 0.85, max_tokens: 1024,
      }),
    }, timeout, 2);
    if (!res.ok) { let msg = `HTTP ${res.status}`; try { const d = await res.json(); msg = d.error?.message || d.error || msg; } catch {} throw new Error(msg); }
    const data = await res.json();
    let txt = data.choices?.[0]?.message?.content || '';
    if (!txt && data.message?.content) txt = data.message.content;
    if (!txt) throw new Error('Empty LLM response');
    return txt;
  }
}

export async function callProviderGeneric(prompt, providerConfig, opts = {}) {
  const baseUrl = String(providerConfig.baseUrl || '').replace(/\/+$/, '');
  const model = String(providerConfig.model || '').trim();
  const apiKey = String(providerConfig.apiKey || '').trim();
  const temperature = opts.temperature ?? 0.4;
  const maxTokens = opts.maxTokens ?? 512;
  const systemPrompt = opts.systemPrompt || '';
  const timeout = opts.timeout ?? 25000;
  const signal = opts.signal;
  if (!prompt || typeof prompt !== 'string') throw new Error('Empty prompt');
  if (isGemini(baseUrl)) {
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const res = await fetchWithRetry(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }] }], generationConfig: { temperature, maxOutputTokens: maxTokens } }),
    }, timeout, 2);
    if (!res.ok) { let msg = `HTTP ${res.status}`; try { const d = await res.json(); msg = d.error?.message || msg; } catch {} throw new Error(msg); }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } else {
    const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    const res = await fetchWithRetry(url, { method: 'POST', headers, signal, body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }) }, timeout, 2);
    if (!res.ok) { let msg = `HTTP ${res.status}`; try { const d = await res.json(); msg = d.error?.message || d.error || msg; } catch {} throw new Error(msg); }
    const data = await res.json();
    let txt = data.choices?.[0]?.message?.content || '';
    if (!txt && data.message?.content) txt = data.message.content;
    return txt;
  }
}
