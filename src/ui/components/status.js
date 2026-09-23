import { DOM } from '../dom.js';

export function showStatus(msg) {
  const el = DOM.statusText;
  if (!el) return;
  const span = el.querySelector('span:last-child');
  if (span) span.textContent = String(msg || '');
  else el.textContent = String(msg || '');
}
