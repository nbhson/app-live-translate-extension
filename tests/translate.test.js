import { describe, it, expect, vi, afterEach } from 'vitest';
import { translateText, _internals } from '../src/services/translate/translate.js';
import { createTranslateCache } from '../src/services/translate/cache.js';

function makeResp({ status = 200, body, retryAfter } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Map(retryAfter ? [['Retry-After', String(retryAfter)]] : []),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('translateText', () => {
  it('returns empty for empty/whitespace input', async () => {
    expect(await translateText('')).toBe('');
    expect(await translateText('   ')).toBe('');
  });

  it('serves cached value without hitting network', async () => {
    const cache = createTranslateCache();
    cache.set('hello', 'xin chào');
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await translateText('hello', { cache })).toBe('xin chào');
    expect(spy).not.toHaveBeenCalled();
  });

  it('translates and populates cache', async () => {
    const cache = createTranslateCache();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResp({ body: [[['xin chào']]] })));
    expect(await translateText('hello', { cache })).toBe('xin chào');
    expect(cache.get('hello')).toBe('xin chào');
  });

  it('retries on 429 honoring Retry-After then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResp({ status: 429, retryAfter: 0 }))
      .mockResolvedValueOnce(makeResp({ body: [[['ok']]] }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await translateText('hello', { retries: 1 });
    expect(out).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns empty after exhausting retries on server errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResp({ status: 503 })));
    expect(await translateText('hello', { retries: 1 })).toBe('');
  });

  it('returns empty when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));
    expect(await translateText('hello', { signal: ac.signal })).toBe('');
  });

  it('chunks long text (>4200 chars) and joins results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResp({ body: [[['V']]] })));
    const text = 'a'.repeat(4500);
    const out = await translateText(text, {});
    expect(out).toBe('V V');
  });
});

describe('chunkBySentence', () => {
  it('splits long text on sentence boundaries', () => {
    const text = Array.from({ length: 100 }, () => 'sentence one.').join(' ');
    const chunks = _internals.chunkBySentence(text, 300);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
  });

  it('force-splits a single oversized segment', () => {
    const big = 'x'.repeat(300);
    const chunks = _internals.chunkBySentence(big, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join('')).toBe(big);
  });

  it('keeps short text whole', () => {
    expect(_internals.chunkBySentence('short', 100)).toEqual(['short']);
  });
});