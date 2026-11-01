import { describe, it, expect } from 'vitest';
import { migrateLegacyApiKey } from '../src/services/migrate-api-key.js';
import { createStorageHarness } from '../src/harness/storage.harness.js';

/** Minimal in-memory chrome.storage.local mock (promise API, like MV3). */
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (keys) => {
      const out = {};
      for (const k of keys) if (k in data) out[k] = data[k];
      return out;
    },
    set: async (obj) => { Object.assign(data, obj); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  };
}

describe('migrate-api-key service', () => {
  it('copies geminiApiKey → providerApiKey when target is empty, then removes legacy key', async () => {
    const s = fakeStorage({ geminiApiKey: 'AIza-legacy' });
    const r = await migrateLegacyApiKey(s);
    expect(r).toEqual({ migrated: true, copied: true });
    expect(s.data.providerApiKey).toBe('AIza-legacy');
    expect('geminiApiKey' in s.data).toBe(false);
  });

  it('keeps existing providerApiKey and only deletes the legacy key', async () => {
    const s = fakeStorage({ providerApiKey: 'current-key', geminiApiKey: 'old-key' });
    const r = await migrateLegacyApiKey(s);
    expect(r).toEqual({ migrated: true, copied: false });
    expect(s.data.providerApiKey).toBe('current-key');
    expect('geminiApiKey' in s.data).toBe(false);
  });

  it('no-op when there is no legacy key', async () => {
    const s = fakeStorage({ providerApiKey: 'k' });
    const r = await migrateLegacyApiKey(s);
    expect(r).toEqual({ migrated: false, copied: false });
    expect(s.data).toEqual({ providerApiKey: 'k' });
  });

  it('treats empty/whitespace legacy key as absent', async () => {
    const s = fakeStorage({ geminiApiKey: '   ' });
    const r = await migrateLegacyApiKey(s);
    expect(r).toEqual({ migrated: false, copied: false });
    expect(s.data.geminiApiKey).toBe('   ');
  });

  it('empty legacy + empty provider → migrated with copied=false', async () => {
    const s = fakeStorage({ geminiApiKey: 'k', providerApiKey: '' });
    const r = await migrateLegacyApiKey(s);
    expect(r.copied).toBe(true);
    expect(s.data.providerApiKey).toBe('k');
  });

  it('falls back to blanking the key when storage.remove is unavailable', async () => {
    const s = fakeStorage({ geminiApiKey: 'k' });
    delete s.remove;
    const r = await migrateLegacyApiKey(s);
    expect(r.migrated).toBe(true);
    expect(s.data.geminiApiKey).toBe('');
    expect(s.data.providerApiKey).toBe('k');
  });

  it('never throws — storage failure returns {migrated:false, error}', async () => {
    const r = await migrateLegacyApiKey({ get: async () => { throw new Error('boom'); }, set: async () => {}, remove: async () => {} });
    expect(r.migrated).toBe(false);
    expect(r.error).toContain('boom');
  });

  it('works through the existing storage harness (callback-style chrome mock)', async () => {
    const backing = { geminiApiKey: 'harness-key' };
    // MV3-style mock: promise when no callback, callback when provided
    const chromeStorage = {
      get: (keys, cb) => {
        const snapshot = () => { const o = {}; for (const k of [].concat(keys)) if (k in backing) o[k] = backing[k]; return o; };
        if (typeof cb === 'function') { cb(snapshot()); return; }
        return Promise.resolve(snapshot());
      },
      set: (obj, cb) => { Object.assign(backing, obj); if (typeof cb === 'function') cb(); return Promise.resolve(); },
      remove: (keys, cb) => { for (const k of [].concat(keys)) delete backing[k]; if (typeof cb === 'function') cb(); return Promise.resolve(); },
    };
    const h = createStorageHarness({ chromeStorage });
    const r = await migrateLegacyApiKey(h);
    expect(r).toEqual({ migrated: true, copied: true });
    expect(backing.providerApiKey).toBe('harness-key');
    expect('geminiApiKey' in backing).toBe(false);
  });
});
