import { CONFIG } from '../../config.js';

export function createTranslateCache(limit = CONFIG.TRANSLATION_CACHE_MAX) {
  const map = new Map();
  const safeLimit = Math.max(1, Math.min(limit || CONFIG.TRANSLATION_CACHE_MAX, 2000));
  return {
    get(k) {
      if (typeof k !== 'string' || !map.has(k)) return undefined;
      const v = map.get(k);
      // LRU touch: move to end
      map.delete(k); map.set(k, v);
      return v;
    },
    set(k, v) {
      if (typeof k !== 'string' || !k) return;
      if (typeof v !== 'string') v = String(v);
      if (map.has(k)) map.delete(k);
      map.set(k, v);
      while (map.size > safeLimit) {
        const first = map.keys().next().value;
        map.delete(first);
      }
    },
    has(k) { return typeof k === 'string' && map.has(k); },
    delete(k) { return map.delete(k); },
    clear() { map.clear(); },
    size() { return map.size; },
    keys() { return [...map.keys()]; },
    _map: map,
  };
}
