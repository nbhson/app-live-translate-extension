import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storageGet, storageSet, isValidUrl, isValidProviderConfig } from '../src/services/storage.js';

describe('isValidUrl', () => {
  it('accepts http/https', () => {
    expect(isValidUrl('https://example.com')).toBe(true);
    expect(isValidUrl('http://localhost:11434/v1')).toBe(true);
  });
  it('rejects invalid', () => {
    expect(isValidUrl('not a url')).toBe(false);
    expect(isValidUrl('ftp://example.com')).toBe(false);
    expect(isValidUrl('')).toBe(false);
    expect(isValidUrl(null)).toBe(false);
  });
});

describe('isValidProviderConfig', () => {
  it('validates config', () => {
    expect(isValidProviderConfig({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' })).toBe(true);
    expect(isValidProviderConfig({ baseUrl: 'invalid', model: 'x' })).toBe(false);
    expect(isValidProviderConfig({ baseUrl: 'https://a.com', model: '' })).toBe(false);
    expect(isValidProviderConfig(null)).toBe(false);
    expect(isValidProviderConfig({})).toBe(false);
  });
});

describe('storageGet', () => {
  it('returns data via promise api', async () => {
    global.chrome.storage.local.get = () => Promise.resolve({ a: 1 });
    expect(await storageGet('a')).toEqual({ a: 1 });
  });

  it('handles invalid keys gracefully', async () => {
    expect(await storageGet(42)).toEqual({});
  });

  it('resolves empty on chrome.runtime.lastError via callback', async () => {
    global.chrome.storage.local.get = (keys, cb) => {
      global.chrome.runtime.lastError = { message: 'fail' };
      cb(null);
    };
    const res = await storageGet('a');
    expect(res).toEqual({});
    global.chrome.runtime.lastError = null;
    global.chrome.storage.local.get = () => Promise.resolve({});
  });
});

describe('storageSet', () => {
  it('resolves for valid object', async () => {
    global.chrome.storage.local.set = () => Promise.resolve();
    await expect(storageSet({ a: 1 })).resolves.toBeUndefined();
  });

  it('no-throw for invalid input', async () => {
    await expect(storageSet(null)).resolves.toBeUndefined();
    await expect(storageSet('string')).resolves.toBeUndefined();
  });

  it('truncates large strings to 8000', async () => {
    let saved = null;
    global.chrome.storage.local.set = (obj) => {
      saved = obj;
      return Promise.resolve();
    };
    const big = 'x'.repeat(9000);
    await storageSet({ k: big });
    expect(saved.k.length).toBe(8000);
    global.chrome.storage.local.set = () => Promise.resolve();
  });

  it('handles lastError via callback', async () => {
    global.chrome.storage.local.set = (obj, cb) => {
      global.chrome.runtime.lastError = { message: 'quota' };
      cb();
    };
    await expect(storageSet({ a: 1 })).resolves.toBeUndefined();
    global.chrome.runtime.lastError = null;
    global.chrome.storage.local.set = () => Promise.resolve();
  });
});
