/**
 * Suggest cache + dedup — saves LLM calls and latency for repeated questions
 * @module services/llm/suggestCache
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 80;

function normalizeQ(q) {
  return String(q || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 160);
}

function hashForSuggest(question, contextTail) {
  const tail = String(contextTail || '').slice(-300).toLowerCase();
  return `${normalizeQ(question)}|${tail}`;
}

class SuggestCache {
  constructor() {
    this.cache = new Map(); // hash -> {data, ts}
    this.inFlight = new Map(); // hash -> Promise
  }
  get(hash) {
    const e = this.cache.get(hash);
    if (!e) return null;
    if (Date.now() - e.ts > CACHE_TTL_MS) { this.cache.delete(hash); return null; }
    // LRU touch
    this.cache.delete(hash); this.cache.set(hash, e);
    return e.data;
  }
  set(hash, data) {
    if (this.cache.size >= MAX_ENTRIES) {
      const first = this.cache.keys().next().value;
      this.cache.delete(first);
    }
    this.cache.set(hash, { data, ts: Date.now() });
  }
  getInFlight(hash) { return this.inFlight.get(hash) || null; }
  setInFlight(hash, promise) {
    this.inFlight.set(hash, promise);
    const cleanup = () => this.inFlight.delete(hash);
    promise.then(cleanup, cleanup);
  }
  clear() { this.cache.clear(); this.inFlight.clear(); }
}

export const suggestCache = new SuggestCache();
export { hashForSuggest, SuggestCache };
