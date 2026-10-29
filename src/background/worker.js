/**
 * Background service worker entry (MV3, ES module) — built by Vite to
 * `dist/background.js` (manifest points there). This replaces the former
 * hand-maintained root `background.js` copy so the canonical, tested
 * `isCapturableTab` is the single runtime implementation (follow-up R2-3).
 *
 * @module background/worker
 */
import { isCapturableTab } from './isCapturableTab.js';

const PANEL_BEHAVIOR = { openPanelOnActionClick: false };

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
  try { await chrome.sidePanel.open({ windowId: tab.windowId }); }
  catch (error) { console.error('[onClicked] open', error); }
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
