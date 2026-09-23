import { describe, it, expect } from 'vitest';
import { createHarness } from '../src/harness/index.js';
import { createChromeHarness } from '../src/harness/chrome.harness.js';
import { createStorageHarness } from '../src/harness/storage.harness.js';
import { createLlmHarness } from '../src/harness/llm.harness.js';
import { createTranslateHarness } from '../src/harness/translate.harness.js';
import { createAudioHarness } from '../src/harness/audio.harness.js';
import { createSpeechHarness } from '../src/harness/speech.harness.js';

describe('harness — composition root', () => {
  it('createHarness returns all ports', () => {
    const h = createHarness();
    expect(h.CONFIG).toBeDefined();
    expect(h.store).toBeDefined();
    expect(h.storage).toBeDefined();
    expect(h.chrome).toBeDefined();
    expect(h.speech).toBeDefined();
    expect(h.audio).toBeDefined();
    expect(h.llm).toBeDefined();
    expect(h.translate).toBeDefined();
  });

  it('allows mock injection', () => {
    const mockChrome = { runtime: { sendMessage: (m, cb) => cb({ ok: 1 }) }, storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } } };
    const h = createHarness({ chromeApi: mockChrome, navigatorApi: { permissions: { query: () => Promise.resolve({ state: 'granted' }) }, mediaDevices: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.resolve({}) } } });
    expect(h.chrome).toBeDefined();
  });

  it('storage harness proxies core', async () => {
    const s = createStorageHarness();
    expect(s.isValidUrl('https://example.com')).toBe(true);
    expect(s.isValidUrl('not-url')).toBe(false);
    const res = await s.get(null);
    expect(res).toBeDefined();
  });

  it('llm harness exposes isGemini', () => {
    const l = createLlmHarness();
    expect(l.isGemini('https://generativelanguage.googleapis.com/v1beta')).toBe(true);
    expect(l.isGemini('https://api.openai.com/v1')).toBe(false);
  });

  it('translate harness exposes cache & translate', async () => {
    const t = createTranslateHarness();
    expect(t.cache).toBeDefined();
    expect(typeof t.translateText).toBe('function');
    const c = t.createCache(2);
    c.set('a', 'b'); expect(c.get('a')).toBe('b');
  });

  it('audio harness pure math', () => {
    const a = createAudioHarness();
    expect(a.computeSpectralCentroid(new Uint8Array([0, 0, 0]), 48000)).toBe(0);
  });

  it('speech harness createRecognition returns null without API', () => {
    const s = createSpeechHarness({ windowApi: {} });
    expect(s.createRecognition()).toBe(null);
  });

  it('chrome harness isCapturableTab delegates to pure', () => {
    const c = createChromeHarness();
    expect(c.isCapturableTab({ id: 1, url: 'https://example.com' })).toBe(true);
    expect(c.isCapturableTab({ id: 1, url: 'chrome://settings' })).toBe(false);
  });
});
