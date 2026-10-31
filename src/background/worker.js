/**
 * Background service worker entry (MV3, ES module) — built by Vite to
 * `dist/background.js` (manifest points there). This replaces the former
 * hand-maintained root `background.js` copy so the canonical, tested
 * `isCapturableTab` is the single runtime implementation (follow-up R2-3).
 *
 * @module background/worker
 */
import { isCapturableTab } from './isCapturableTab.js';
import { isSiteDisabled } from '../utils/siteMatch.js';

const PANEL_BEHAVIOR = { openPanelOnActionClick: false };
const DISABLED_SITES_KEY = 'disabledSites';

/** Per-site disable list (chrome.storage.local) — checked before opening.
 *  CRITICAL: sidePanel.open() requires a live user gesture; any `await`
 *  (e.g. chrome.storage.local.get) before it invalidates the gesture and
 *  the panel fails to open. So the list is cached in memory (sync read),
 *  hydrated at worker start and kept fresh via chrome.storage.onChanged. */
let disabledSitesCache = [];

function hydrateDisabledSitesCache() {
  chrome.storage.local.get([DISABLED_SITES_KEY])
    .then((r) => {
      disabledSitesCache = Array.isArray(r[DISABLED_SITES_KEY]) ? r.disabledSites : [];
    })
    .catch((e) => console.error('[worker] disabledSites hydrate', e));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(DISABLED_SITES_KEY in changes)) return;
  const nv = changes[DISABLED_SITES_KEY].newValue;
  disabledSitesCache = Array.isArray(nv) ? nv : [];
});

/** Synchronous check against the in-memory cache — safe to call right
 *  before chrome.sidePanel.open() without breaking the user gesture. */
function isSiteDisabledForTabSync(tab) {
  if (!tab || typeof tab.url !== 'string' || !tab.url) return false;
  try {
    return isSiteDisabled(tab.url, disabledSitesCache);
  } catch (e) {
    console.error('[worker] disabledSites check', e);
    return false;
  }
}

/** Flash a short badge marker when the panel open was suppressed for this site. */
function flashOffBadge() {
  try {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#e11d48' });
    setTimeout(() => { try { chrome.action.setBadgeText({ text: '' }); } catch { /* worker may be gone */ } }, 2500);
  } catch (e) { console.error('[worker] badge', e); }
}

/** Open the side panel for a window (user gesture required: click or command). */
async function openPanelForWindow(windowId) {
  try { await chrome.sidePanel.open({ windowId }); }
  catch (error) { console.error('[worker] sidePanel.open', error); }
}

function setPanelBehavior() {
  chrome.sidePanel
    .setPanelBehavior(PANEL_BEHAVIOR)
    .catch((error) => console.error('[sidePanel] setPanelBehavior', error));
}

chrome.runtime.onInstalled.addListener(() => { setPanelBehavior(); hydrateDisabledSitesCache(); });
chrome.runtime.onStartup.addListener(() => { setPanelBehavior(); hydrateDisabledSitesCache(); });
// Set immediately for the running worker too.
setPanelBehavior();
hydrateDisabledSitesCache();

// Manual open on action click (primary path, NOT fallback):
// the onClicked dispatch carries the user gesture that grants activeTab,
// which chrome.tabCapture.getMediaStreamId REQUIRES
// ("Extension has not been invoked" otherwise).
// Native open (openPanelOnActionClick:true) is faster but skips the grant
// and breaks tab audio — do NOT switch back without a host-permission flow.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || typeof tab.windowId !== 'number') { console.warn('[onClicked] invalid tab', tab); return; }
  // sidePanel.open() MUST run with zero awaits before it (user gesture).
  // The disabled-sites check is a synchronous in-memory cache lookup.
  if (isSiteDisabledForTabSync(tab)) {
    console.info('[onClicked] suppressed: site disabled by user', tab.url);
    flashOffBadge();
    return;
  }
  await openPanelForWindow(tab.windowId);
});

// Global keyboard shortcut (Alt+Shift+L) — commands carry a user gesture in MV3,
// so sidePanel.open is allowed from onCommand.
chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'toggle-panel') return;
  try {
    // Only chrome.tabs.query runs before open (the documented pattern for
    // onCommand); the disabled-sites check is synchronous (in-memory cache).
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || typeof tab.windowId !== 'number') return;
    if (isSiteDisabledForTabSync(tab)) { flashOffBadge(); return; }
    await openPanelForWindow(tab.windowId);
  } catch (error) { console.error('[onCommand] open', error); }
});

/**
 * Get the active tab in the last focused window (validated).
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return (tabs && tabs[0]) || null;
  } catch (error) {
    console.error('[worker] tabs.query', error);
    return null;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'get-tab-stream-id') return false;
  (async () => {
    try {
      const activeTab = await getActiveTab();
      if (!activeTab) { sendResponse({ error: 'No active tab found.' }); return; }
      if (!isCapturableTab(activeTab)) {
        const reason = (activeTab && !activeTab.url)
          ? 'missing tab URL — reload the extension and click its icon on this tab to grant access'
          : String(activeTab.url);
        sendResponse({ error: `Tab does not support capture: ${reason}` }); return;
      }
      chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id }, (streamId) => {
        if (chrome.runtime.lastError) { console.error('[getMediaStreamId]', chrome.runtime.lastError.message); sendResponse({ error: chrome.runtime.lastError.message }); }
        else if (!streamId || typeof streamId !== 'string') sendResponse({ error: 'Failed to get streamId' });
        else sendResponse({ streamId });
      });
    } catch (e) { console.error('[onMessage]', e); sendResponse({ error: String(e && e.message || e) }); }
  })();
  return true;
});
