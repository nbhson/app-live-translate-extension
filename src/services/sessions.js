/**
 * Session snapshots — pure, testable, no chrome imports.
 * A session is an auto-saved snapshot of a finished recording: EN/VI pairs
 * plus the last AI summary. Restoring renders a read-only block into the
 * transcript feed — it never mutates live STT/suggestion state (indexes,
 * question maps), which would corrupt re-keying.
 * @module services/sessions
 */

export const SESSIONS_MAX = 20;
export const SESSION_PAIRS_MAX = 300;

let idCounter = 0;
/** @returns {string} */
function nextId(ts) {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `s${ts.toString(36)}-${idCounter.toString(36)}`;
}

/**
 * Build a session snapshot from parallel EN/VI phrase arrays (validated, capped).
 * @param {{en: string[], vi: string[], summary?: string, ts?: number}} input
 * @returns {{id:string, ts:number, pairs:Array<{en:string,vi:string}>, summary:string}|null}
 */
export function createSessionSnapshot({ en, vi, summary = '', ts = Date.now() } = {}) {
  const ens = Array.isArray(en) ? en : [];
  const vis = Array.isArray(vi) ? vi : [];
  const pairs = [];
  for (let i = 0; i < Math.min(ens.length, SESSION_PAIRS_MAX); i++) {
    const e = String(ens[i] || '').trim();
    const v = String(vis[i] || '').trim();
    if (e || v) pairs.push({ en: e, vi: v });
  }
  if (!pairs.length) return null;
  return {
    id: nextId(ts),
    ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
    pairs,
    summary: String(summary || '').trim(),
  };
}

/**
 * Prepend snapshot to list, capped. Returns a new array.
 * @template T
 * @param {T[]} list
 * @param {T} snapshot
 * @param {number} [max]
 * @returns {T[]}
 */
export function appendSession(list, snapshot, max = SESSIONS_MAX) {
  const base = Array.isArray(list) ? list : [];
  if (!snapshot) return base.slice(0, max);
  const merged = [snapshot, ...base];
  return merged.length > max ? merged.slice(0, max) : merged;
}

/**
 * Parse/validate stored sessions — never throws, caps size.
 * @param {unknown} raw
 * @param {{max?: number}} [opts]
 * @returns {Array}
 */
export function parseSessions(raw, { max = SESSIONS_MAX } = {}) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const s of arr.slice(0, max)) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.pairs)) continue;
    const pairs = s.pairs
      .slice(0, SESSION_PAIRS_MAX)
      .map((p) => ({ en: String(p?.en || '').trim(), vi: String(p?.vi || '').trim() }))
      .filter((p) => p.en || p.vi);
    if (!pairs.length) continue;
    out.push({
      id: typeof s.id === 'string' && s.id ? s.id : nextId(s.ts || Date.now()),
      ts: Number.isFinite(s.ts) && s.ts > 0 ? s.ts : 0,
      pairs,
      summary: String(s.summary || '').trim(),
    });
  }
  return out;
}

function formatTs(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

/**
 * Session as plain text (for export/restore preview).
 * @param {{ts:number, pairs:Array<{en:string,vi:string}>, summary?:string}} session
 * @returns {string}
 */
export function sessionToText(session) {
  if (!session || !Array.isArray(session.pairs)) return '';
  const body = session.pairs.map((p) => `${p.en || '—'}\n${p.vi || '—'}`).join('\n\n');
  const summary = session.summary ? `\n\n---\n${session.summary}` : '';
  return `[${formatTs(session.ts)}]\n${body}${summary}`;
}
