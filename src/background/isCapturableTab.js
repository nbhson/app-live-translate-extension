const ALLOWED_CAPTURE_SCHEMES = Object.freeze(['http:', 'https:']);
const BLOCKED_HOSTS = Object.freeze(['chrome.google.com', 'chromewebstore.google.com', 'accounts.google.com']);

function isBlockedHost(hostname) {
  const h = String(hostname).toLowerCase();
  return BLOCKED_HOSTS.some(b => h === b || h.endsWith('.' + b));
}

/**
 * Check if tab is capturable — pure, testable, no chrome dependency
 * @param {unknown} tab
 * @returns {boolean}
 */
export function isCapturableTab(tab) {
  if (!tab || typeof tab !== 'object') return false;
  const t = tab;
  if (typeof t.id !== 'number' || typeof t.url !== 'string') return false;
  const urlStr = t.url.trim();
  if (!urlStr || urlStr.startsWith('chrome://') || urlStr.startsWith('chrome-extension://') || urlStr.startsWith('about:') || urlStr.startsWith('edge://')) return false;
  try {
    const u = new URL(urlStr);
    if (!ALLOWED_CAPTURE_SCHEMES.includes(u.protocol)) return false;
    if (isBlockedHost(u.hostname)) return false;
    // file:// not capturable via tabCapture
    if (u.protocol === 'file:') return false;
    return true;
  } catch {
    return false;
  }
}
