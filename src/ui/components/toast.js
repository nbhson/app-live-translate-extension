import { DOM } from '../dom.js';

export function showToast(message, type = 'default') {
  const container = DOM.toastContainer;
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success' ? '✅' : type === 'error' ? '⚠️' : '💬';
  // Use textContent for message to prevent XSS, icon is static
  const iconEl = document.createElement('span');
  iconEl.className = 'toast-icon';
  iconEl.textContent = icon;
  const msgEl = document.createElement('span');
  msgEl.textContent = String(message || '');
  toast.append(iconEl, msgEl);
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s forwards';
    setTimeout(() => toast.remove(), 300);
  }, 2600);
}
