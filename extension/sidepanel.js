// Relay side panel — the extension's primary surface. Renders in Chrome's own
// side panel (NOT injected into linkedin.com), so it never modifies LinkedIn's
// page and can't be detected by a page-scan. Two jobs:
//   1. "On this profile" — import the LinkedIn profile in the active tab.
//   2. "Sync inbox" — the LinkedIn / Sales Navigator syncs (moved from popup).

const RELAY = 'http://localhost:3030';

const el = (id) => document.getElementById(id);
const connDot = el('connDot');
const connText = el('connText');
const profileEmpty = el('profileEmpty');
const profileBody = el('profileBody');
const profileName = el('profileName');
const profileHeadline = el('profileHeadline');
const profileStatus = el('profileStatus');
const profileStatusText = el('profileStatusText');
const importBtn = el('importBtn');
const syncBtn = el('syncBtn');
const snSyncBtn = el('snSyncBtn');
const progressEl = el('progress');
const hintEl = el('hint');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYNC_ICON_IDLE = `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;
const SYNC_ICON_RUNNING = `<svg width="14" height="14" class="spin" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 .49-4.79"></path></svg>`;

// ── App connection status ────────────────────────────────────────────────
async function checkConnection() {
  try {
    const r = await fetch(`${RELAY}/api/state`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}
function renderConnection(ok) {
  connDot.className = 'conn-dot ' + (ok ? 'on' : 'off');
  connText.textContent = ok ? 'Connected' : 'App not running';
}

// ── Active tab → current LinkedIn profile ────────────────────────────────
function slugFromUrl(url) {
  const m = (url || '').match(/^https?:\/\/www\.linkedin\.com\/in\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}
// One-shot READ of the page (name + headline) for display only. Reading the
// DOM is not injection — nothing is added to LinkedIn's page, nothing persists.
async function readProfileDisplay(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const h1 = document.querySelector('h1');
        const name = h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : '';
        const headline = document.querySelector('.text-body-medium.break-words')?.textContent?.replace(/\s+/g, ' ').trim() || '';
        return { name, headline };
      },
    });
    return res?.result || { name: '', headline: '' };
  } catch { return { name: '', headline: '' }; }
}
async function fetchStatus(slug) {
  try {
    const r = await fetch(`${RELAY}/api/contacts/by-slug/${encodeURIComponent(slug)}/status`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) return await r.json(); // { exists, messageable }
  } catch {}
  return null;
}

let currentSlug = null;
let currentTabId = null;

async function renderProfile() {
  const tab = await getActiveTab();
  const slug = tab ? slugFromUrl(tab.url) : null;
  currentSlug = slug;
  currentTabId = tab?.id ?? null;

  if (!slug) {
    profileBody.classList.add('hidden');
    profileEmpty.classList.remove('hidden');
    return;
  }
  profileEmpty.classList.add('hidden');
  profileBody.classList.remove('hidden');

  // Name/headline from the page (best-effort); fall back to a tidied slug.
  const { name, headline } = await readProfileDisplay(tab.id);
  profileName.textContent = name || slug.replace(/-+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  profileHeadline.textContent = headline || '';

  // Relay status.
  profileStatus.className = 'profile-status';
  profileStatusText.textContent = 'Checking…';
  const status = await fetchStatus(slug);
  applyStatus(status);
}

function applyStatus(status) {
  if (status?.exists) {
    profileStatus.className = 'profile-status in';
    profileStatusText.textContent = status.messageable ? 'In Relay · in your inbox' : 'In Relay';
    importBtn.textContent = 'Re-import';
    importBtn.disabled = false;
  } else {
    profileStatus.className = 'profile-status';
    profileStatusText.textContent = 'Not in Relay yet';
    importBtn.textContent = 'Import to Relay';
    importBtn.disabled = false;
  }
}

// ── Import the current profile ───────────────────────────────────────────
importBtn.addEventListener('click', async () => {
  if (!currentSlug || currentTabId == null) return;
  const slug = currentSlug;
  importBtn.disabled = true;
  importBtn.innerHTML = `${SYNC_ICON_RUNNING} Importing…`;

  // Ask the profile-capture content script (already running on the /in/ page)
  // to capture the profile in place — no new tab, no on-page UI.
  let acked = false;
  try {
    const resp = await chrome.tabs.sendMessage(currentTabId, { action: 'relay-import-current-profile' });
    acked = !!resp?.ok;
  } catch {
    // Content script not present (page not fully loaded, or not an /in/ page).
    importBtn.disabled = false;
    importBtn.textContent = 'Import to Relay';
    profileStatusText.textContent = 'Reload the profile, then try again';
    return;
  }
  if (!acked) { /* still poll — capture may have started anyway */ }

  // Poll status until the contact lands (capture runs async, ~5–20s).
  for (let i = 0; i < 14; i++) {
    await sleep(2000);
    if (currentSlug !== slug) return; // user navigated away
    const status = await fetchStatus(slug);
    if (status?.exists) {
      importBtn.innerHTML = 'Imported ✓';
      await sleep(900);
      importBtn.textContent = 'Re-import';
      importBtn.disabled = false;
      applyStatus(status);
      return;
    }
  }
  // Timed out — capture may still complete shortly.
  importBtn.disabled = false;
  importBtn.textContent = 'Import to Relay';
  profileStatusText.textContent = 'Still importing… check Relay in a moment';
});

// ── Sync (LinkedIn + Sales Navigator) ────────────────────────────────────
function runSync(btn, idleLabel, action, payload, onResult) {
  btn.disabled = true;
  const otherDisabled = btn === syncBtn ? snSyncBtn : syncBtn;
  otherDisabled.disabled = true;
  btn.innerHTML = `${SYNC_ICON_RUNNING} Syncing…`;
  progressEl.textContent = '';
  chrome.runtime.sendMessage({ action, ...payload }, (response) => {
    btn.disabled = false;
    otherDisabled.disabled = false;
    btn.innerHTML = `${SYNC_ICON_IDLE} ${idleLabel}`;
    if (chrome.runtime.lastError) {
      progressEl.textContent = 'Error: ' + chrome.runtime.lastError.message;
      return;
    }
    if (!response?.ok) {
      const reason = response?.reason ?? 'Unknown error';
      progressEl.textContent = 'Failed: ' + reason;
      if (/not-logged-in/i.test(reason)) hintEl.textContent = 'Sign into LinkedIn in this browser, then retry.';
      return;
    }
    onResult(response);
    // Re-check the current profile in case the sync added it.
    renderProfile();
  });
}

syncBtn.addEventListener('click', () => {
  runSync(syncBtn, 'Sync LinkedIn inbox', 'liInitialSyncApi', { deepFetch: true }, (r) => {
    const convs = r.convs ?? r.count ?? 0;
    const msgs = r.msgs ?? r.messageCount ?? 0;
    progressEl.textContent = `Synced ${convs} conversations · ${msgs} messages`;
  });
});
snSyncBtn.addEventListener('click', () => {
  runSync(snSyncBtn, 'Sync Sales Navigator', 'snFullSyncApi', {}, (r) => {
    progressEl.textContent = `Synced ${r.threads ?? 0} SN threads · ${r.deepMsgs ?? 0} messages`;
  });
});

// Live progress messages from the background service worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === 'progress' && typeof msg.message === 'string') {
    progressEl.textContent = msg.message;
  }
});

// ── React to tab changes so the profile section stays current ────────────
chrome.tabs.onActivated.addListener(() => renderProfile());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status === 'complete') {
    getActiveTab().then((t) => { if (t && t.id === tabId) renderProfile(); });
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────
async function refresh() {
  renderConnection(await checkConnection());
  await renderProfile();
}
refresh();
setInterval(() => checkConnection().then(renderConnection), 8000);
