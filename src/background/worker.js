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

/** Per-site disable list (chrome.storage.local) — checked before opening. */
async function isSiteDisabledForTab(tab) {
  if (!tab || typeof tab.url !== 'string' || !tab.url) return false;
  try {
    const r = await chrome.storage.local.get([DISABLED_SITES_KEY]);
    const patterns = Array.isArray(r[DISABLED_SITES_KEY]) ? r.disabledSites : [];
    return isSiteDisabled(tab.url, patterns);
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

chrome.runtime.onInstalled.addListener(setPanelBehavior);
chrome.runtime.onStartup.addListener(setPanelBehavior);
// Set immediately for the running worker too.
setPanelBehavior();

// Manual open on action click (primary path, NOT fallback):
// the onClicked dispatch carries the user gesture that grants activeTab,
// which chrome.tabCapture.getMediaStreamId REQUIRES
// ("Extension has not been invoked" otherwise).
// Native open (openPanelOnActionClick:true) is faster but skips the grant
// and breaks tab audio — do NOT switch back without a host-permission flow.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || typeof tab.windowId !== 'number') { console.warn('[onClicked] invalid tab', tab); return; }
  if (await isSiteDisabledForTab(tab)) {
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
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || typeof tab.windowId !== 'number') return;
    if (await isSiteDisabledForTab(tab)) { flashOffBadge(); return; }
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
