/**
 * Storage Harness — wraps chrome.storage.local with validation & quota guard.
 * Mirrors sidepanel.js:storageGet/storageSet so both runtimes share contract.
 * @module harness/storage.harness
 */
import { storageGet as coreGet, storageSet as coreSet, isValidUrl, isValidProviderConfig } from '../services/storage.js';

export function createStorageHarness({ chromeStorage } = {}) {
  const _get = chromeStorage?.get ? (k) => chromeStorage.get(k) : null;
  const _set = chromeStorage?.set ? (o) => chromeStorage.set(o) : null;

  return {
    get: _get ? (keys) => {
      try {
        if (keys != null && typeof keys !== 'string' && !Array.isArray(keys) && typeof keys !== 'object') {
          console.warn('[StorageHarness.get] invalid keys', keys);
          return Promise.resolve({});
        }
        const p = _get(keys);
        if (p && typeof p.then === 'function') return p.catch((e) => { console.warn('[StorageHarness.get] async', e); return {}; });
        return new Promise((res) => _get(keys, (r) => {
          if (chrome.runtime?.lastError) { console.warn('[StorageHarness.get] lastError', chrome.runtime.lastError.message); res({}); }
          else res(r || {});
        }));
      } catch (e) { console.warn('[StorageHarness.get]', e); return Promise.resolve({}); }
    } : coreGet,

    set: _set ? (obj) => {
      try {
        if (!obj || typeof obj !== 'object') return Promise.resolve();
        for (const k of Object.keys(obj)) { const v = obj[k]; if (typeof v === 'string' && v.length > 8000) obj[k] = v.slice(-8000); }
        const p = _set(obj);
        if (p && typeof p.then === 'function') return p.catch((e) => { console.warn('[StorageHarness.set] async', e); });
        return new Promise((res) => _set(obj, () => {
          if (chrome.runtime?.lastError) console.warn('[StorageHarness.set] lastError', chrome.runtime.lastError.message);
          res();
        }));
      } catch (e) { console.warn('[StorageHarness.set]', e); return Promise.resolve({}); }
    } : coreSet,

    isValidUrl,
    isValidProviderConfig,
  };
}

export const storageHarness = createStorageHarness();
