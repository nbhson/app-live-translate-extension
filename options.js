// Live Translate — Options page (Round 2; ESM since Round 3)
// Manages: per-site disable list, data (history/sessions), theme default.
// ES module: imports the canonical src/utils + src/services modules directly —
// same code as the sidepanel and service worker (no global bundle).

import { escapeHtml } from './src/utils/escapeHtml.js';
import * as siteMatch from './src/utils/siteMatch.js';
import * as historyStore from './src/services/history.js';
import * as sessionStore from './src/services/sessions.js';

const DISABLED_SITES_KEY = 'disabledSites';
const HISTORY_KEY = 'history';
const SESSIONS_KEY = 'sessions';
const THEME_DEFAULT_KEY = 'app_theme_default';

const $id = (id) => document.getElementById(id);
const saveStatus = $id('saveStatus');

function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (r) => {
        if (chrome.runtime.lastError) { console.warn('[options] storageGet', chrome.runtime.lastError.message); resolve({}); }
        else resolve(r || {});
      });
    } catch (e) { console.warn('[options] storageGet', e); resolve({}); }
  });
}
function storageSet(obj) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime.lastError) { console.warn('[options] storageSet', chrome.runtime.lastError.message); resolve(false); }
        else resolve(true);
      });
    } catch (e) { console.warn('[options] storageSet', e); resolve(false); }
  });
}

/** Flash a transient status line (never silent on failure). */
function flashStatus(text, isError = false) {
  if (!saveStatus) return;
  saveStatus.textContent = text;
  saveStatus.style.color = isError ? '#f87171' : '';
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => { if (saveStatus) saveStatus.textContent = ''; }, 2500);
}

function escapeHtmlSafe(s) { return escapeHtml(s); }

function downloadTextFile(filename, content, mime) {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { console.error('[options] download', e); flashStatus('Export failed', true); }
}

// --- Per-site disable list ---

async function renderSiteList() {
  const listEl = $id('siteList');
  if (!listEl) return;
  const r = await storageGet([DISABLED_SITES_KEY]);
  const patterns = Array.isArray(r[DISABLED_SITES_KEY]) ? r[DISABLED_SITES_KEY] : [];
  listEl.textContent = '';
  if (!patterns.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Không có trang nào bị tắt.';
    listEl.appendChild(li);
    return;
  }
  for (const p of patterns) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'pattern';
    span.textContent = String(p);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'site-remove';
    btn.textContent = 'Bật lại';
    btn.setAttribute('aria-label', 'Enable ' + String(p));
    btn.addEventListener('click', async () => {
      const cur = await storageGet([DISABLED_SITES_KEY]);
      const next = (Array.isArray(cur[DISABLED_SITES_KEY]) ? cur[DISABLED_SITES_KEY] : []).filter((x) => x !== p);
      if (await storageSet({ [DISABLED_SITES_KEY]: next })) { flashStatus('Đã bật lại ' + String(p)); await renderSiteList(); }
      else flashStatus('Không lưu được', true);
    });
    li.appendChild(span); li.appendChild(btn);
    listEl.appendChild(li);
  }
}

function setupAddSiteForm() {
  const form = $id('addSiteForm');
  const input = $id('sitePatternInput');
  const errEl = $id('siteError');
  if (!form || !input) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const norm = siteMatch.normalizeSitePattern(input.value);
    if (!norm) {
      if (errEl) { errEl.textContent = 'Pattern không hợp lệ — dùng dạng example.com hoặc docs.example.com/path'; errEl.style.display = 'block'; }
      return;
    }
    if (errEl) errEl.style.display = 'none';
    const r = await storageGet([DISABLED_SITES_KEY]);
    const patterns = Array.isArray(r[DISABLED_SITES_KEY]) ? r[DISABLED_SITES_KEY] : [];
    if (!patterns.includes(norm)) patterns.push(norm);
    if (await storageSet({ [DISABLED_SITES_KEY]: patterns })) {
      input.value = '';
      flashStatus('Đã thêm ' + norm);
      await renderSiteList();
    } else flashStatus('Không lưu được', true);
  });
}

// --- Data (history + sessions) ---

async function renderDataStats() {
  const r = await storageGet([HISTORY_KEY, SESSIONS_KEY]);
  const history = historyStore.parseHistory(r[HISTORY_KEY]);
  const sessions = sessionStore.parseSessions(r[SESSIONS_KEY]);
  const hs = $id('historyStats');
  if (hs) hs.textContent = `Lịch sử: ${history.length} cặp EN→VI`;
  const sc = $id('sessionsCount');
  if (sc) sc.textContent = `Phiên đã lưu: ${sessions.length}`;
}

function setupDataActions() {
  const txtBtn = $id('exportHistoryTxtBtn');
  if (txtBtn) txtBtn.addEventListener('click', async () => {
    const r = await storageGet([HISTORY_KEY]);
    downloadTextFile('live-translate-history.txt', historyStore.historyToText(historyStore.parseHistory(r[HISTORY_KEY])), 'text/plain;charset=utf-8');
  });
  const jsonBtn = $id('exportHistoryJsonBtn');
  if (jsonBtn) jsonBtn.addEventListener('click', async () => {
    const r = await storageGet([HISTORY_KEY]);
    downloadTextFile('live-translate-history.json', historyStore.historyToJson(historyStore.parseHistory(r[HISTORY_KEY])), 'application/json;charset=utf-8');
  });
  const clearHistBtn = $id('clearHistoryBtn');
  if (clearHistBtn) clearHistBtn.addEventListener('click', async () => {
    if (!window.confirm('Xóa toàn bộ lịch sử dịch?')) return;
    if (await storageSet({ [HISTORY_KEY]: [] })) { flashStatus('Đã xóa lịch sử'); await renderDataStats(); }
    else flashStatus('Không xóa được', true);
  });
  const clearSessBtn = $id('clearSessionsBtn');
  if (clearSessBtn) clearSessBtn.addEventListener('click', async () => {
    if (!window.confirm('Xóa các phiên đã lưu?')) return;
    if (await storageSet({ [SESSIONS_KEY]: [] })) { flashStatus('Đã xóa phiên đã lưu'); await renderDataStats(); }
    else flashStatus('Không xóa được', true);
  });
}

// --- Theme default (sidepanel reads app_theme_default when user hasn't chosen) ---

async function setupThemeDefault() {
  const sel = $id('themeDefault');
  if (!sel) return;
  const r = await storageGet([THEME_DEFAULT_KEY]);
  sel.value = ['system', 'light', 'dark'].includes(r[THEME_DEFAULT_KEY]) ? r[THEME_DEFAULT_KEY] : 'system';
  sel.addEventListener('change', async () => {
    if (await storageSet({ [THEME_DEFAULT_KEY]: sel.value })) flashStatus('Đã lưu giao diện mặc định');
    else flashStatus('Không lưu được', true);
  });
}

async function init() {
  const v = $id('aboutVersion');
  try { if (v) v.textContent = `Phiên bản ${chrome.runtime.getManifest().version}`; }
  catch (e) { if (v) v.textContent = ''; }
  setupAddSiteForm();
  setupDataActions();
  setupThemeDefault();
  await Promise.all([renderSiteList(), renderDataStats()]);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void init(); });
else void init();
