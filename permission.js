'use strict';
/** Permission page — validated, no unhandled throw, specific error handling */
const grantBtn = document.getElementById('grantBtn');
const requestArea = document.getElementById('requestArea');
const grantedArea = document.getElementById('grantedArea');
const iconBox = document.getElementById('iconBox');

if (grantBtn) grantBtn.addEventListener('click', async () => {
  grantBtn.disabled = true; grantBtn.textContent = 'Requesting...';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try { stream.getTracks().forEach(t => { try { t.stop(); } catch {} }); } catch {}
    if (requestArea) requestArea.style.display = 'none';
    if (grantedArea) grantedArea.style.display = 'block';
    if (iconBox) {
      iconBox.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
      iconBox.style.boxShadow = '0 0 25px rgba(16, 185, 129, 0.4)';
      iconBox.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    }
    setTimeout(() => { try { window.close(); } catch {} }, 1500);
  } catch (error) {
    console.error('[permission]', error);
    const name = error && error.name;
    let msg = 'Cannot access microphone. Check browser/device permissions.';
    if (name === 'NotAllowedError') msg = 'You denied microphone permission. Please allow it in Settings > Privacy.';
    else if (name === 'NotFoundError') msg = 'Microphone not found.';
    else if (name === 'NotReadableError') msg = 'Microphone is in use by another app.';
    alert(msg);
    grantBtn.disabled = false; grantBtn.textContent = 'Allow Microphone Access';
  }
});
