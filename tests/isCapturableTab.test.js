import { describe, it, expect } from 'vitest';
import { isCapturableTab } from '../src/background/isCapturableTab.js';

describe('isCapturableTab', () => {
  it('valid http/https', () => {
    expect(isCapturableTab({ id: 1, url: 'https://example.com' })).toBe(true);
    expect(isCapturableTab({ id: 2, url: 'http://localhost:3000' })).toBe(true);
    expect(isCapturableTab({ id: 3, url: 'https://google.com/search?q=test' })).toBe(true);
  });

  it('rejects non-http', () => {
    expect(isCapturableTab({ id: 1, url: 'chrome://extensions' })).toBe(false);
    expect(isCapturableTab({ id: 1, url: 'chrome-extension://abc' })).toBe(false);
    expect(isCapturableTab({ id: 1, url: 'file:///tmp/a.html' })).toBe(false);
    expect(isCapturableTab({ id: 1, url: 'about:blank' })).toBe(false);
  });

  it('rejects chrome.google.com', () => {
    expect(isCapturableTab({ id: 1, url: 'https://chrome.google.com/webstore' })).toBe(false);
  });

  it('invalid inputs', () => {
    expect(isCapturableTab(null)).toBe(false);
    expect(isCapturableTab(undefined)).toBe(false);
    expect(isCapturableTab({})).toBe(false);
    expect(isCapturableTab({ id: '1', url: 'https://example.com' })).toBe(false);
    expect(isCapturableTab({ id: 1, url: 123 })).toBe(false);
    expect(isCapturableTab({ id: 1, url: 'not a url' })).toBe(false);
  });
});
