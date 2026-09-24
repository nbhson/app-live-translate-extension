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
  // Reduced from 30s to 20s for faster failure; retry still covers transient 429/5xx (max ~40s total)
  const timeout = opts.timeout ?? 20000;
  const signal = opts.signal;

  // helper to extract meaningful error from Gemini response
  function geminiEmptyReason(data) {
    const cand = data?.candidates?.[0];
    if (!cand) {
      const block = data?.promptFeedback?.blockReason;
      if (block) return `Blocked by Gemini: ${block}`;
      return 'Empty LLM response';
    }
    const fr = cand.finishReason;
    if (fr && fr !== 'STOP' && fr !== 'stop') {
      // SAFETY, RECITATION, MAX_TOKENS, etc.
      if (fr === 'SAFETY') return 'Empty LLM response (blocked by safety filter)';
      if (fr === 'RECITATION') return 'Empty LLM response (recitation block)';
      if (fr === 'MAX_TOKENS') return 'Empty LLM response (max tokens reached)';
      return `Empty LLM response (finishReason: ${fr})`;
    }
    return 'Empty LLM response';
  }

  // retry helper: shorten prompt for output-limit retries (1-2 câu đầu không thể tràn input, nhưng output 3×120 từ ~600 tokens có thể tràn với local model context nhỏ)
  function shortenPromptForRetry(p) {
    return String(p).replace(/60-120 words/g, '30-60 words').replace(/3-5 sentences/g, '2-3 sentences');
  }

  // Build JSON-mode aware payload helpers
  function geminiJsonConfig(maxTokens) {
    return { temperature: 0.8, maxOutputTokens: maxTokens, responseMimeType: 'application/json' };
  }
  if (isGemini(baseUrl)) {
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
    let lastEmptyErr = null;
    let curMax = opts.quality === 'fast' ? 512 : 1024;
    let curPrompt = prompt;
    // streaming fast-path if requested and not local
    if (opts.stream && opts.onChunk && !isLocal) {
      try {
        const streamUrl = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}&alt=sse`;
        const sRes = await fetchWithRetry(streamUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ contents: [{ parts: [{ text: curPrompt }] }], generationConfig: geminiJsonConfig(curMax) }),
        }, timeout, 0);
        if (sRes.ok && sRes.body && sRes.body.getReader) {
          const reader = sRes.body.getReader();
          const decoder = new TextDecoder();
          let acc = '';
          let buf = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
              const t = line.trim();
              if (!t.startsWith('data:')) continue;
              const payload = t.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const j = JSON.parse(payload);
                const chunk = j.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (chunk) { acc += chunk; try { opts.onChunk(acc); } catch {} }
              } catch {}
            }
          }
          if (acc && acc.trim()) return acc;
        }
      } catch (e) { console.warn('[provider] Gemini stream fallback', e.message); }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchWithRetry(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ contents: [{ parts: [{ text: curPrompt }] }], generationConfig: geminiJsonConfig(curMax) }),
      }, timeout, 1);
      if (!res.ok) { let msg = `HTTP ${res.status}`; try { const d = await res.json(); msg = d.error?.message || msg; } catch {} throw new Error(msg); }
      const data = await res.json();
      const txt = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (txt && txt.trim()) return txt;
      const reason = geminiEmptyReason(data);
      console.warn(`[provider] Gemini attempt ${attempt+1} empty: ${reason} (prompt ${curPrompt.length} chars, max ${curMax})`, data);
      lastEmptyErr = new Error(reason);
      if (reason.includes('max tokens') || reason.includes('MAX_TOKENS')) { curMax = 1800; curPrompt = shortenPromptForRetry(curPrompt); }
      if (attempt === 0) await new Promise(r => setTimeout(r, 600));
    }
    throw lastEmptyErr;
  } else {
    const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const isOllama = /ollama/i.test(baseUrl) || /ollama/i.test(model);
    let lastEmptyErr = null;
    // Ollama Cloud rất chậm với prompt dài + JSON mode: hạ token + bỏ response_format/stream
    let curMax = isOllama ? (opts.quality === 'fast' ? 384 : 700) : (opts.quality === 'fast' ? 512 : 1024);
    let curPrompt = prompt;
    // streaming fast-path for OpenAI-compatible — tắt cho Ollama (OpenAI compat của Ollama Cloud không ổn định, gây 400 + retry chậm)
    if (opts.stream && opts.onChunk && !isLocal && !isOllama) {
      try {
        const sRes = await fetchWithRetry(url, {
          method: 'POST', headers, signal,
          body: JSON.stringify({
            model, messages: [
              { role: 'system', content: 'You output ONLY JSON object with "structures" and "answers" arrays. No markdown, no extra text.' },
              { role: 'user', content: curPrompt },
            ], temperature: 0.85, max_tokens: curMax, stream: true, response_format: { type: 'json_object' },
          }),
        }, timeout, 0);
        if (sRes.ok && sRes.body && sRes.body.getReader) {
          const reader = sRes.body.getReader();
          const decoder = new TextDecoder();
          let acc = '';
          let buf = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
              const t = line.trim();
              if (!t.startsWith('data:')) continue;
              const payload = t.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const j = JSON.parse(payload);
                const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || '';
                if (delta) { acc += delta; try { opts.onChunk(acc); } catch {} }
              } catch {}
            }
          }
          if (acc && acc.trim()) return acc;
        }
      } catch (e) { console.warn('[provider] OpenAI stream fallback', e.message); }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const payload = {
        model, messages: [
          { role: 'system', content: 'You output ONLY JSON object with "structures" and "answers" arrays. No markdown, no extra text.' },
          { role: 'user', content: curPrompt },
        ], temperature: isOllama ? 0.7 : 0.85, max_tokens: curMax, ...(isOllama ? {} : { response_format: { type: 'json_object' } }),
      };
      // Ollama Cloud không hỗ trợ response_format ổn định — gửi thẳng không có, tránh 400 + retry x2 chậm
      let res = await fetchWithRetry(url, { method: 'POST', headers, signal, body: JSON.stringify(payload) }, timeout, 1);
      if (!res.ok && res.status === 400 && !isOllama) {
        try { await res.text(); } catch {}
        delete payload.response_format;
        res = await fetchWithRetry(url, { method: 'POST', headers, signal, body: JSON.stringify(payload) }, timeout, 0);
      }
      if (!res.ok) { let msg = `HTTP ${res.status}`; try { const d = await res.json(); msg = d.error?.message || d.error || msg; } catch {} throw new Error(msg); }
      const data = await res.json();
      let txt = data.choices?.[0]?.message?.content || '';
      if (!txt && data.message?.content) txt = data.message.content;
      if (!txt && typeof data.response === 'string') txt = data.response;
      if (txt && txt.trim()) return txt;
      const finish = data.choices?.[0]?.finish_reason;
      const usage = data.usage;
      console.warn(`[provider] OpenAI attempt ${attempt+1} empty: finish=${finish} usage=${JSON.stringify(usage)} prompt ${curPrompt.length} chars max ${curMax}`, data);
      if (finish === 'content_filter') lastEmptyErr = new Error('Empty LLM response (content filter)');
      else if (finish === 'length') { lastEmptyErr = new Error('Empty LLM response (max tokens / length)'); curMax = 1800; curPrompt = shortenPromptForRetry(curPrompt); }
      else lastEmptyErr = new Error('Empty LLM response');
      if (attempt === 0) await new Promise(r => setTimeout(r, 600));
    }
    throw lastEmptyErr;
  }
}

export async function callProviderGeneric(prompt, providerConfig, opts = {}) {
  const baseUrl = String(providerConfig.baseUrl || '').replace(/\/+$/, '');
  const model = String(providerConfig.model || '').trim();
  const apiKey = String(providerConfig.apiKey || '').trim();
  const temperature = opts.temperature ?? 0.4;
  const maxTokens = opts.maxTokens ?? 512;
  const systemPrompt = opts.systemPrompt || '';
  const timeout = opts.timeout ?? 18000;
  const signal = opts.signal;
  if (!prompt || typeof prompt !== 'string') throw new Error('Empty prompt');
  if (isGemini(baseUrl)) {
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const res = await fetchWithRetry(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }] }], generationConfig: { temperature, maxOutputTokens: maxTokens } }),
    }, timeout, 1);
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
    const res = await fetchWithRetry(url, { method: 'POST', headers, signal, body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }) }, timeout, 1);
    if (!res.ok) { let msg = `HTTP ${res.status}`; try { const d = await res.json(); msg = d.error?.message || d.error || msg; } catch {} throw new Error(msg); }
    const data = await res.json();
    let txt = data.choices?.[0]?.message?.content || '';
    if (!txt && data.message?.content) txt = data.message.content;
    return txt;
  }
}
