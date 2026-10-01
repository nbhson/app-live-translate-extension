/**
 * Storage service — promise wrapper + validation + no throw
 * @module services/storage
 */

/** Per-key persist caps. compressedSummary holds the rolling meeting bullets and
 * must survive hour-long meetings; everything else keeps the 8000 quota guard. */
export const STORAGE_STRING_CAPS = Object.freeze({
  compressedSummary: 20000,
  default: 8000,
});

export function capForStorage(key, value) {
  if (typeof value !== 'string') return value;
  const cap = STORAGE_STRING_CAPS[key] ?? STORAGE_STRING_CAPS.default;
  return value.length > cap ? value.slice(-cap) : value;
}
export function storageGet(keys) {
  try {
    // validate keys
    if (keys != null && typeof keys !== 'string' && !Array.isArray(keys) && typeof keys !== 'object') {
      console.warn('[storageGet] invalid keys', keys);
      return Promise.resolve({});
    }
    const p = chrome.storage.local.get(keys);
    if (p && typeof p.then === 'function') return p.catch(e => { console.warn('[storageGet] async', e); return {}; });
    return new Promise((res) => chrome.storage.local.get(keys, (r) => {
      if (chrome.runtime.lastError) { console.warn('[storageGet] lastError', chrome.runtime.lastError.message); res({}); }
      else res(r || {});
    }));
  } catch (e) {
    console.warn('[storageGet]', e);
    return Promise.resolve({});
  }
}

export function storageSet(obj) {
  try {
    if (!obj || typeof obj !== 'object') return Promise.resolve();
    // cap size to avoid quota exceeded — per-key caps (compressedSummary keeps tail up to 20000)
    for (const k of Object.keys(obj)) {
      obj[k] = capForStorage(k, obj[k]);
    }
    const p = chrome.storage.local.set(obj);
    if (p && typeof p.then === 'function') return p.catch(e => { console.warn('[storageSet] async', e); });
    return new Promise((res) => chrome.storage.local.set(obj, () => {
      if (chrome.runtime.lastError) console.warn('[storageSet] lastError', chrome.runtime.lastError.message);
      res();
    }));
  } catch (e) {
    console.warn('[storageSet]', e);
    return Promise.resolve();
  }
}

export function isValidUrl(s) {
  try {
    const u = new URL(String(s));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isValidProviderConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  return isValidUrl(cfg.baseUrl) && typeof cfg.model === 'string' && !!cfg.model.trim();
}
