const syncBtn = document.getElementById('syncBtn');
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

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  syncBtn.innerHTML = `
    <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="animation:spin 1s linear infinite">
      <polyline points="1 4 1 10 7 10"></polyline>
      <path d="M3.51 15a9 9 0 1 0 .49-4.79"></path>
    </svg>
    Syncing…`;

  const style = document.createElement('style');
  style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);

  progressEl.textContent = '';
  hintEl.textContent = '';
  setStatus('Looking for LinkedIn tab…');

  try {
    // Find or open LinkedIn messaging tab
    let [liTab] = await chrome.tabs.query({ url: '*://www.linkedin.com/messaging*' });

    if (!liTab) {
      setStatus('Opening LinkedIn messaging…');
      liTab = await chrome.tabs.create({ url: 'https://www.linkedin.com/messaging', active: false });
      // Wait for the tab to load
      await new Promise((resolve) => {
        chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
          if (tabId === liTab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        });
      });
    }

    // Ensure content script is injected (re-inject if needed)
    await chrome.scripting.executeScript({
      target: { tabId: liTab.id },
      files: ['content.js'],
    }).catch(() => {}); // Ignore if already injected

    setStatus('Fetching conversations…');

    // Send sync message to content script
    const result = await chrome.tabs.sendMessage(liTab.id, { action: 'sync' });

    if (result?.error) {
      setStatus('Error: ' + result.error, 'error');
      hintEl.textContent = 'Make sure you are logged in to LinkedIn.';
      return;
    }

    const count = result?.count || 0;
    const conversations = (result?.conversations || []).map(c => ({
      ...c,
      _src: c._src || 'li',
    }));

    if (count === 0) {
      setStatus('No conversations found. Debug copied to clipboard.', 'error');
      const dbg = result?.debugLog || 'no debug info';
      console.log('[InboxPro debug]\n' + dbg);
      try { await navigator.clipboard.writeText(dbg); } catch (e) {}
      hintEl.textContent = 'Paste the clipboard in chat.';
      return;
    }

    const msgCount = result?.messageCount || 0;
    progressEl.textContent = `Loaded ${count} conversations · ${msgCount} messages`;
    setStatus(`Synced ${count} conversations & ${msgCount} messages`, 'success');

    // Send to background to open InboxPro
    await chrome.runtime.sendMessage({
      action: 'openApp',
      conversations,
      messages: result?.messages || {},
      entities: result?.entities || {},
      myProfileUrn: result?.myProfileUrn || '',
    });

  } catch (e) {
    setStatus('Error: ' + e.message, 'error');
    console.error('[InboxPro]', e);
  } finally {
    syncBtn.disabled = false;
    syncBtn.innerHTML = `
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <polyline points="1 4 1 10 7 10"></polyline>
        <path d="M3.51 15a9 9 0 1 0 .49-4.79"></path>
      </svg>
      Sync Now`;
    hintEl.textContent = 'Make sure InboxPro is running on localhost:3030';
  }
});
