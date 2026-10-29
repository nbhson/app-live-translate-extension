/**
 * Per-site pattern matching — pure, testable, no chrome imports.
 * Patterns: "example.com", "docs.example.com/meetings" (host + optional path
 * prefix). A leading "*." is accepted and stripped (subdomains always match).
 * @module utils/siteMatch
 */

/**
 * Normalize a user-entered pattern → "host[/path]" (lowercase, no scheme,
 * no trailing slash). Returns null for empty/invalid input.
 * @param {string} input
 * @returns {string|null}
 */
export function normalizeSitePattern(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^\*\./, '').replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  // strip port? keep host only up to first slash; drop credentials if any
  const slash = s.indexOf('/');
  let hostPart = slash === -1 ? s : s.slice(0, slash);
  let pathPart = slash === -1 ? '' : s.slice(slash);
  hostPart = hostPart.split('@').pop() || '';
  hostPart = hostPart.split(':')[0] || '';
  if (!hostPart || !hostPart.includes('.') || /\s/.test(hostPart)) return null;
  // Query strings are not part of path-prefix matching: URL.pathname never
  // carries the query, so "example.com/meet?id=1" would otherwise never match.
  pathPart = pathPart.split('?')[0];
  pathPart = pathPart.replace(/\/+$/, '');
  return pathPart ? hostPart + pathPart : hostPart;
}

function hostMatches(patternHost, hostname) {
  const h = String(hostname || '').toLowerCase();
  const p = String(patternHost || '').toLowerCase();
  return h === p || h.endsWith('.' + p);
}

/**
 * True when the URL matches ANY of the (already normalized or raw) patterns.
 * Invalid patterns are ignored — never throw.
 * @param {string} url
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function isSiteDisabled(url, patterns) {
  if (!Array.isArray(patterns) || !patterns.length) return false;
  let u;
  try { u = new URL(String(url || '')); } catch { return false; }
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  for (const raw of patterns) {
    const norm = normalizeSitePattern(raw);
    if (!norm) continue;
    const slash = norm.indexOf('/');
    const pH = slash === -1 ? norm : norm.slice(0, slash);
    const pPath = slash === -1 ? '' : norm.slice(slash);
    if (!hostMatches(pH, u.hostname)) continue;
    if (!pPath) return true;
    // pattern path prefix must match a real path segment boundary
    // (URL.pathname never contains the query — it was stripped at normalize time)
    if (pathname === pPath || pathname.startsWith(pPath + '/')) return true;
  }
  return false;
}
