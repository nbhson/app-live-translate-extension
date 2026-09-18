/**
 * Storage service — promise wrapper + validation + no throw
 * @module services/storage
 */
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
    // cap size to avoid quota exceeded — truncate large strings
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string' && v.length > 8000) obj[k] = v.slice(-8000);
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
