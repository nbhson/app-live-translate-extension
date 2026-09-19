/**
 * Chrome Harness — isolates all chrome.* APIs behind injectable adapter.
 * Side-panel runtime delegates to this; tests inject mock chrome.
 * @module harness/chrome.harness
 */
import { isCapturableTab as pureIsCapturable } from '../background/isCapturableTab.js';

export function createChromeHarness({ chromeApi, navigatorApi } = {}) {
  const _chrome = chromeApi ?? (typeof chrome !== 'undefined' ? chrome : null);
  const _nav = navigatorApi ?? (typeof navigator !== 'undefined' ? navigator : null);

  return {
    isCapturableTab: pureIsCapturable,

    sendMessage(msg) {
      return new Promise((resolve) => {
        try {
          _chrome.runtime.sendMessage(msg, (resp) => {
            if (_chrome.runtime.lastError) resolve({ error: _chrome.runtime.lastError.message });
            else resolve(resp);
          });
        } catch (e) { resolve({ error: String(e) }); }
      });
    },

    async checkMicPermission() {
      try {
        const status = await _nav.permissions.query({ name: 'microphone' });
        if (status && typeof status.state === 'string') return status.state === 'granted';
      } catch (e) { console.warn('[ChromeHarness.checkMicPermission] permissions.query', e); }
      try {
        const devices = await _nav.mediaDevices.enumerateDevices();
        const hasInput = devices.some((d) => d.kind === 'audioinput');
        if (!hasInput) return false;
        return false;
      } catch { return false; }
    },

    openPermissionTab() {
      try { _chrome.tabs.create({ url: _chrome.runtime.getURL('permission.html') }); }
      catch (e) { console.error('[ChromeHarness.openPermissionTab]', e); }
    },

    async getTabStreamId() {
      const resp = await this.sendMessage({ type: 'get-tab-stream-id' });
      if (!resp || resp.error || !resp.streamId) throw new Error(resp?.error || 'No streamId');
      return resp.streamId;
    },

    async getTabMediaStream(streamId) {
      const stream = await _nav.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
        video: false,
      });
      return stream;
    },

    async getMicMediaStream() {
      return _nav.mediaDevices.getUserMedia({ audio: true });
    },
  };
}

export const chromeHarness = createChromeHarness();
