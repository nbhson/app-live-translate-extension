/**
 * Translation history — pure, testable, no chrome imports.
 * Entries: { id, ts, en, vi }. Storage adapter lives in the caller
 * (sidepanel/options persist via chrome.storage.local under 'history').
 * @module services/history
 */

export const HISTORY_MAX_ENTRIES = 500;

let idCounter = 0;
/** @returns {string} */
function nextId(ts) {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `h${ts.toString(36)}-${idCounter.toString(36)}`;
}

/**
 * Create a validated history entry. Returns null when there is nothing to record.
 * @param {string} en
 * @param {string} vi
 * @param {number} [ts]
 * @returns {{id:string, ts:number, en:string, vi:string}|null}
 */
export function createHistoryEntry(en, vi, ts = Date.now()) {
  const e = String(en || '').trim();
  const v = String(vi || '').trim();
  if (!e && !v) return null;
  const t = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
  return { id: nextId(t), ts: t, en: e, vi: v };
}

/**
 * Append entries (or single entry) to the front of the list, capped.
 * @template T
 * @param {T[]} list
 * @param {T|T[]} entries
 * @param {number} [max]
 * @returns {T[]}
 */
export function appendHistoryEntries(list, entries, max = HISTORY_MAX_ENTRIES) {
  const base = Array.isArray(list) ? list : [];
  const add = Array.isArray(entries) ? entries : [entries];
  const merged = [...add.filter(Boolean), ...base];
  return merged.length > max ? merged.slice(0, max) : merged;
}

/**
 * Case-insensitive substring search across EN + VI (empty query = all).
 * @param {Array<{en:string, vi:string}>} entries
 * @param {string} query
 * @returns {Array}
 */
export function searchHistory(entries, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return Array.isArray(entries) ? entries.slice() : [];
  return (Array.isArray(entries) ? entries : []).filter((e) =>
    String(e?.en || '').toLowerCase().includes(q) || String(e?.vi || '').toLowerCase().includes(q)
  );
}

function formatTs(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

/**
 * Export as plain text — human-readable transcript pairs.
 * @param {Array<{ts:number, en:string, vi:string}>} entries
 * @returns {string}
 */
export function historyToText(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list
    .map((e, i) => `[${i + 1} • ${formatTs(e?.ts)}]\n${e?.en || '—'}\n${e?.vi || '—'}`)
    .join('\n\n');
}

/**
 * Export as JSON envelope (stable shape for re-import via parseHistory).
 * @param {Array} entries
 * @returns {string}
 */
export function historyToJson(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return JSON.stringify({
    format: 'live-translate-history',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: list.length,
    entries: list,
  }, null, 2);
}

/**
 * Parse/validate a stored or imported history payload — never throws, caps size.
 * @param {unknown} raw
 * @param {{max?: number}} [opts]
 * @returns {Array<{id:string, ts:number, en:string, vi:string}>}
 */
export function parseHistory(raw, { max = HISTORY_MAX_ENTRIES } = {}) {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
  const out = [];
  for (const item of arr.slice(0, max)) {
    if (!item || typeof item !== 'object') continue;
    const en = String(item.en || '').trim();
    const vi = String(item.vi || '').trim();
    if (!en && !vi) continue;
    const ts = Number.isFinite(item.ts) && item.ts > 0 ? item.ts : 0;
    out.push({ id: typeof item.id === 'string' && item.id ? item.id : nextId(ts || Date.now()), ts, en, vi });
  }
  return out;
}

export const _internals = { nextId };
