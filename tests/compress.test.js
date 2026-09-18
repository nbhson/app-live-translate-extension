import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCompressService } from '../src/services/llm/compress.js';

function fakeStore(initial = {}) {
  let state = {
    compressInProgress: false,
    compressEnabled: true,
    providerConfig: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', apiKey: '' },
    finalizedEnPhrases: ['hello world', 'how are you', 'fine thanks'],
    lastCompressedIdx: 0,
    compressedSummary: '',
    compressTimer: null,
    isListening: false,
    activeAudioTrack: null,
    ...initial,
  };
  return {
    getState: () => state,
    setState: (patch) => { state = { ...state, ...patch }; },
    _get: () => state,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createCompressService', () => {
  it('early return if provider not configured and manual', async () => {
    const store = fakeStore({ providerConfig: { baseUrl: '', model: '', apiKey: '' } });
    const showToast = vi.fn();
    const svc = createCompressService(store, { showStatus: vi.fn(), showToast, updateCompressToggleUI: vi.fn() });
    await svc.perform(true);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('AI Provider not configured'), 'error');
  });

  it('early return if not enough sentences', async () => {
    const store = fakeStore({ finalizedEnPhrases: ['one'], lastCompressedIdx: 0 });
    const showToast = vi.fn();
    const svc = createCompressService(store, { showStatus: vi.fn(), showToast, updateCompressToggleUI: vi.fn() });
    await svc.perform(true);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Not enough sentences'), 'default');
  });

  it('does not run when disabled and not manual', async () => {
    const store = fakeStore({ compressEnabled: false });
    const showToast = vi.fn();
    const svc = createCompressService(store, { showStatus: vi.fn(), showToast, updateCompressToggleUI: vi.fn() });
    await svc.perform(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('compresses segment and updates store/storage', async () => {
    const store = fakeStore();
    const showToast = vi.fn();
    const showStatus = vi.fn();
    const updateCompressToggleUI = vi.fn();
    // mock provider fetch: callProviderGeneric uses fetchWithRetry -> stub fetch
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: '• bullet1\n• bullet2' } }] }),
      text: async () => '',
    }));
    // stub chrome storage
    global.chrome.storage.local.set = vi.fn().mockReturnValue(Promise.resolve());

    const svc = createCompressService(store, { showStatus, showToast, updateCompressToggleUI });
    await svc.perform(true);

    expect(store.getState().lastCompressedIdx).toBe(3);
    expect(store.getState().compressedSummary).toContain('bullet1');
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Compressed 3 sentences'), 'success');
    expect(updateCompressToggleUI).toHaveBeenCalled();
    expect(store.getState().compressInProgress).toBe(false);
  });

  it('handles empty provider response', async () => {
    const store = fakeStore();
    const showToast = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: '' } }] }),
      text: async () => '',
    }));
    global.chrome.storage.local.set = vi.fn().mockReturnValue(Promise.resolve());
    const svc = createCompressService(store, { showStatus: vi.fn(), showToast, updateCompressToggleUI: vi.fn() });
    await svc.perform(true);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Compression returned empty'), 'error');
  });

  it('start/stop timer', () => {
    vi.useFakeTimers();
    const store = fakeStore({ compressEnabled: true });
    const svc = createCompressService(store, { showStatus: vi.fn(), showToast: vi.fn(), updateCompressToggleUI: vi.fn() });
    svc.start();
    expect(store.getState().compressTimer).not.toBeNull();
    svc.stop();
    expect(store.getState().compressTimer).toBeNull();
    vi.useRealTimers();
  });
});
