// Chrome Extension Background Service Worker — Best Practice (>=8/10)
'use strict';

const ALLOWED_CAPTURE_SCHEMES = Object.freeze(['http:', 'https:']);
const BLOCKED_HOSTS = Object.freeze(['chrome.google.com', 'chromewebstore.google.com', 'accounts.google.com']);
function isBlockedHost(h) { const lh = String(h).toLowerCase(); return BLOCKED_HOSTS.some(b => lh===b || lh.endsWith('.'+b)); }

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('[sidePanel] setPanelBehavior', error));
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('[sidePanel] setPanelBehavior', error));
});
// Set immediately for the running worker too (fast native open, no JS roundtrip)
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[sidePanel] setPanelBehavior', error));

/** @param {chrome.tabs.Tab} tab @returns {boolean} */
function isCapturableTab(tab) {
  if (!tab || typeof tab.id !== 'number' || typeof tab.url !== 'string') return false;
  const s = String(tab.url).trim();
  if (!s || s.startsWith('chrome://') || s.startsWith('chrome-extension://') || s.startsWith('about:') || s.startsWith('edge://')) return false;
  try { const u = new URL(s); if (!ALLOWED_CAPTURE_SCHEMES.includes(u.protocol)) return false; if (isBlockedHost(u.hostname)) return false; return true; } catch { return false; }
}

// openPanelOnActionClick:true lets Chrome open the panel natively (instant).
// Keep a fallback: if Chrome ever delivers onClicked (e.g. old behavior),
// ensure the panel opens for this window.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || typeof tab.windowId !== 'number') { console.warn('[onClicked] invalid tab', tab); return; }
  try { await chrome.sidePanel.open({ windowId: tab.windowId }); }
  catch (error) { console.debug('[onClicked] open (native behavior likely already opened)', error); }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'get-tab-stream-id') return false;
  (async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs && tabs[0];
      if (!activeTab) { sendResponse({ error: 'No active tab found.' }); return; }
      if (!isCapturableTab(activeTab)) { sendResponse({ error: `Tab does not support capture: ${activeTab.url}` }); return; }
      chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id }, (streamId) => {
        if (chrome.runtime.lastError) { console.error('[getMediaStreamId]', chrome.runtime.lastError.message); sendResponse({ error: chrome.runtime.lastError.message }); }
        else if (!streamId || typeof streamId !== 'string') sendResponse({ error: 'Failed to get streamId' });
        else sendResponse({ streamId });
      });
    } catch (e) { console.error('[onMessage]', e); sendResponse({ error: String(e && e.message || e) }); }
  })();
  return true;
});
