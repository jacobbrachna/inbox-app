const syncBtn = document.getElementById('syncBtn');
const snSyncBtn = document.getElementById('snSyncBtn');
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');
const hintEl = document.getElementById('hint');

function setStatus(text, type = '') {
  statusEl.textContent = text;
  statusEl.className = 'status-box' + (type ? ' ' + type : '');
}

// Load last sync info on open
chrome.storage.local.get(['lastSyncedAt', 'conversationCount'], (data) => {
  if (data.lastSyncedAt) {
    const d = new Date(data.lastSyncedAt);
    setStatus(`Last sync: ${d.toLocaleTimeString()} · ${data.conversationCount || 0} conversations`, 'success');
  }
});

// Listen for progress messages from content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'progress') {
    progressEl.textContent = message.message;
  }
});

document.getElementById('dumpBtn').addEventListener('click', async () => {
  setStatus('Dumping sample…');
  try {
    let [liTab] = await chrome.tabs.query({ url: '*://www.linkedin.com/messaging*' });
    if (!liTab) {
      setStatus('Open linkedin.com/messaging first', 'error');
      return;
    }
    await chrome.scripting.executeScript({ target: { tabId: liTab.id }, files: ['content.js'] }).catch(() => {});
    const result = await chrome.tabs.sendMessage(liTab.id, { action: 'dumpSample' });
    const text = JSON.stringify(result, null, 2);
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${text.length} chars to clipboard`, 'success');
  } catch (e) {
    setStatus('Error: ' + e.message, 'error');
  }
});

const SYNC_ICON_IDLE = `
  <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
    <polyline points="23 4 23 10 17 10"></polyline>
    <polyline points="1 20 1 14 7 14"></polyline>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
  </svg>`;
const SYNC_ICON_RUNNING = `
  <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="animation:spin 1s linear infinite">
    <polyline points="1 4 1 10 7 10"></polyline>
    <path d="M3.51 15a9 9 0 1 0 .49-4.79"></path>
  </svg>`;

syncBtn.addEventListener('click', () => {
  syncBtn.disabled = true;
  syncBtn.innerHTML = `${SYNC_ICON_RUNNING} Syncing…`;
  progressEl.textContent = '';
  hintEl.textContent = '';
  setStatus('Syncing LinkedIn inbox via API…');

  // API-driven sync runs in the background service worker using your
  // logged-in cookies. No need to open a LinkedIn tab. Background fires
  // `progress` messages on chrome.runtime so the listener above updates the
  // progress line live.
  chrome.runtime.sendMessage(
    { action: 'liInitialSyncApi', deepFetch: true },
    (response) => {
      syncBtn.disabled = false;
      syncBtn.innerHTML = `${SYNC_ICON_IDLE} Sync LinkedIn inbox`;
      hintEl.textContent = 'Make sure Relay is running on localhost:3030';

      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message, 'error');
        return;
      }
      if (!response?.ok) {
        const reason = response?.reason ?? 'Unknown error';
        setStatus('Sync failed: ' + reason, 'error');
        if (/not-logged-in/i.test(reason)) {
          hintEl.textContent = 'Sign in to LinkedIn in this browser, then retry.';
        }
        return;
      }
      const convs = response.convs ?? response.count ?? 0;
      const msgs = response.msgs ?? response.messageCount ?? 0;
      progressEl.textContent = `${convs} conversations · ${msgs} messages`;
      setStatus(`Synced ${convs} conversations & ${msgs} messages`, 'success');
      chrome.storage.local.set({
        lastSyncedAt: Date.now(),
        conversationCount: convs,
      });
    },
  );
});

snSyncBtn.addEventListener('click', () => {
  snSyncBtn.disabled = true;
  snSyncBtn.innerHTML = `${SYNC_ICON_RUNNING} Syncing…`;
  progressEl.textContent = '';
  hintEl.textContent = '';
  setStatus('Syncing Sales Navigator via API…');

  // Mirrors the LinkedIn sync above — runs the 3-phase SN sync
  // (inbox → per-thread messages → profile enrichment) in the background
  // service worker using your logged-in cookies. Live phase progress arrives
  // on the same `progress` channel the listener above handles.
  chrome.runtime.sendMessage(
    { action: 'snFullSyncApi' },
    (response) => {
      snSyncBtn.disabled = false;
      snSyncBtn.innerHTML = `${SYNC_ICON_IDLE} Sync Sales Navigator`;
      hintEl.textContent = 'Make sure Relay is running on localhost:3030';

      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message, 'error');
        return;
      }
      if (!response?.ok) {
        const reason = response?.reason ?? 'Unknown error';
        setStatus('SN sync failed: ' + reason, 'error');
        if (/not-logged-in/i.test(reason)) {
          hintEl.textContent = 'Sign in to LinkedIn / Sales Navigator in this browser, then retry.';
        }
        return;
      }
      const threads = response.threads ?? 0;
      const msgs = response.deepMsgs ?? 0;
      const profiles = response.profilesFetched ?? 0;
      progressEl.textContent = `${threads} threads · ${msgs} messages · ${profiles} profiles`;
      setStatus(`Synced ${threads} SN threads & ${msgs} messages`, 'success');
      chrome.storage.local.set({ lastSnSyncedAt: Date.now() });
    },
  );
});
