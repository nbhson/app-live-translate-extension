/**
 * Hostname-based local-URL check.
 * `url.includes('localhost')` matched `https://evil.com/?x=localhost` — a
 * remote host was treated as local (API key bypass + wrong error hints).
 * Parse the hostname instead; unparseable URLs are treated as remote.
 * @param {string} u
 * @returns {boolean}
 */
export function isLocalHostUrl(u) {
  try {
    const h = new URL(String(u)).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

/** Hostname-exact Gemini API check (never matches query strings or subdomains). */
export function isGeminiHostUrl(u) {
  try {
    return new URL(String(u)).hostname === 'generativelanguage.googleapis.com';
  } catch {
    return false;
  }
}
