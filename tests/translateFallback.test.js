import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  translateViaMyMemory,
  translateViaLingva,
  translateViaAI,
  translateWithFallbackChain,
  _internals,
} from '../src/services/translate/providers.js';
import { translateText } from '../src/services/translate/translate.js';

function jsonResp(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('translateViaMyMemory', () => {
  it('returns translatedText on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResp({ responseData: { translatedText: 'xin chào' }, responseStatus: 200 })));
    expect(await translateViaMyMemory('hello')).toBe('xin chào');
  });
  it('returns empty on quota warning', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResp({ responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL' }, responseStatus: 429 })));
    expect(await translateViaMyMemory('hello')).toBe('');
  });
  it('returns empty on non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResp({}, false, 429)));
    expect(await translateViaMyMemory('hello')).toBe('');
  });
  it('chunks long text', () => {
    const chunks = _internals.chunkForMyMemory('a'.repeat(1000), 450);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 450)).toBe(true);
  });
});

describe('translateViaLingva', () => {
  it('returns translation from first instance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResp({ translation: 'xin chào' })));
    expect(await translateViaLingva('hello')).toBe('xin chào');
  });
  it('tries next instance on failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp({}, false, 500))
      .mockResolvedValueOnce(jsonResp({ translation: 'chào' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await translateViaLingva('hello')).toBe('chào');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('returns empty for oversized text', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await translateViaLingva('x'.repeat(2500))).toBe('');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('translateViaAI', () => {
  it('returns cleaned AI output', async () => {
    const callGeneric = vi.fn().mockResolvedValue('"xin chào"');
    const cfg = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-x' };
    expect(await translateViaAI('hello', cfg, callGeneric)).toBe('xin chào');
  });
  it('returns empty when provider not configured', async () => {
    const callGeneric = vi.fn();
    expect(await translateViaAI('hello', { baseUrl: '', model: '' }, callGeneric)).toBe('');
    expect(callGeneric).not.toHaveBeenCalled();
  });
});

describe('translateWithFallbackChain', () => {
  it('tries mymemory then lingva then ai', async () => {
    const fetchMock = vi.fn()
      // mymemory fail
      .mockResolvedValueOnce(jsonResp({}, false, 429))
      // lingva fail then success
      .mockResolvedValueOnce(jsonResp({}, false, 500))
      .mockResolvedValueOnce(jsonResp({ translation: 'chào bạn' }));
    vi.stubGlobal('fetch', fetchMock);
    const { text, via } = await translateWithFallbackChain('hello friend', { disableAI: true });
    expect(text).toBe('chào bạn');
    expect(via).toBe('lingva');
  });
  it('falls through to AI when free APIs fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResp({}, false, 500)));
    const callGeneric = vi.fn().mockResolvedValue('xin chào từ AI');
    const { text, via } = await translateWithFallbackChain('hello', {
      providerConfig: { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k' },
      callGeneric,
    });
    expect(via).toBe('ai');
    expect(text).toBe('xin chào từ AI');
  });
});

describe('translateText with fallback', () => {
  it('uses MyMemory when Google 429s', async () => {
    const fetchMock = vi.fn((url) => {
      if (String(url).includes('translate.googleapis.com')) return Promise.resolve(jsonResp({}, false, 429));
      if (String(url).includes('mymemory')) return Promise.resolve(jsonResp({ responseData: { translatedText: 'xin chào' }, responseStatus: 200 }));
      return Promise.resolve(jsonResp({}, false, 500));
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await translateText('hello', { retries: 0, disableAI: true });
    expect(out).toBe('xin chào');
  });
  it('still returns empty when all providers fail and fallback disabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResp({}, false, 503)));
    expect(await translateText('hello', { retries: 0, fallback: false })).toBe('');
  });
});
