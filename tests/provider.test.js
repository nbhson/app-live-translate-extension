import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fetchWithTimeout, fetchWithRetry, callProviderForSuggest, callProviderGeneric, isGemini } from '../src/services/llm/provider.js';

function makeResp({ status = 200, body = {}, headersMap } = {}) {
  const headers = headersMap || new Map();
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers.get(k) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isGemini', () => {
  it('detects Gemini URL', () => {
    expect(isGemini('https://generativelanguage.googleapis.com/v1beta')).toBe(true);
    expect(isGemini('https://api.openai.com/v1')).toBe(false);
  });
});

describe('fetchWithTimeout', () => {
  it('resolves when fetch succeeds before timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResp({ body: { ok: 1 } })));
    const res = await fetchWithTimeout('https://example.com', {}, 1000);
    expect(res.ok).toBe(true);
  });

  it('rejects with AbortError when external signal aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_, opts) => {
      return new Promise((_, reject) => {
        if (opts.signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
        else opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }));
    await expect(fetchWithTimeout('https://example.com', { signal: ac.signal }, 5000)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts after timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_, opts) => {
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }));
    await expect(fetchWithTimeout('https://example.com', {}, 20)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('fetchWithRetry', () => {
  it('retries on 429 then succeeds', async () => {
    const m = new Map([['Retry-After', '0']]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResp({ status: 429, headersMap: m }))
      .mockResolvedValueOnce(makeResp({ body: { ok: 1 } }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('https://example.com', {}, 1000, 1);
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns non-retryable status directly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResp({ status: 400, body: { error: 'bad' } })));
    const res = await fetchWithRetry('https://example.com', {}, 1000, 2);
    expect(res.status).toBe(400);
  });

  it('retries on network error then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(makeResp({ body: { ok: 1 } }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('https://example.com', {}, 1000, 1);
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws AbortError without retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));
    await expect(fetchWithRetry('https://example.com', {}, 1000, 2)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('callProviderForSuggest', () => {
  const gConfig = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'k', model: 'gemini-2.5-flash' };
  const oConfig = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' };
  const localConfig = { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.1' };

  it('throws on missing baseUrl/model', async () => {
    await expect(callProviderForSuggest('hi', { baseUrl: '', model: '' })).rejects.toThrow('Missing baseUrl/model');
  });

  it('throws on missing apiKey for non-local', async () => {
    await expect(callProviderForSuggest('hi', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: '' })).rejects.toThrow('Missing apiKey');
  });

  it('throws on empty prompt', async () => {
    await expect(callProviderForSuggest('', gConfig)).rejects.toThrow('Empty prompt');
  });

  it('calls Gemini and returns text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResp({
      body: { candidates: [{ content: { parts: [{ text: '{"structures":["H1"],"answers":["A1 paragraph with 3 sentences. Second sentence here. Third sentence completes."]}' }] } }] },
    })));
    const txt = await callProviderForSuggest('prompt', gConfig);
    expect(txt).toContain('A1 paragraph');
  });

  it('calls OpenAI-compatible and returns text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResp({
      body: { choices: [{ message: { content: '{"answers":["hello world paragraph. Second sentence here. Third one."]}' } }] },
    })));
    const txt = await callProviderForSuggest('prompt', oConfig);
    expect(txt).toContain('hello world');
  });

  it('allows local without apiKey', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResp({
      body: { choices: [{ message: { content: 'ok paragraph. Second sentence. Third.' } }] },
    })));
    const txt = await callProviderForSuggest('prompt', localConfig);
    expect(txt).toBe('ok paragraph. Second sentence. Third.');
  });

  it('throws on empty LLM response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResp({
      body: { candidates: [{ content: { parts: [{ text: '' }] } }] },
    })));
    await expect(callProviderForSuggest('prompt', gConfig)).rejects.toThrow('Empty LLM response');
  });

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResp({ status: 401, body: { error: { message: 'Unauthorized' } } })));
    await expect(callProviderForSuggest('prompt', gConfig)).rejects.toThrow('Unauthorized');
  });
});

describe('callProviderGeneric', () => {
  const cfg = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' };

  it('throws on empty prompt', async () => {
    await expect(callProviderGeneric('', cfg)).rejects.toThrow('Empty prompt');
  });

  it('returns text for generic call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResp({
      body: { choices: [{ message: { content: 'summary bullet' } }] },
    })));
    const txt = await callProviderGeneric('Summarize', cfg, { systemPrompt: 'You are helper' });
    expect(txt).toBe('summary bullet');
  });
});
