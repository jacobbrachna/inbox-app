// Runs on localhost:3030 (InboxPro). Lets the page request a refresh from
// the extension via window.postMessage — no externally_connectable / extension
// ID juggling required.

console.log('[InboxPro bridge] loaded on', location.href);

// Stamp a sentinel into the page DOM so the page can detect us synchronously.
// Content scripts and page scripts share the DOM but not the JS context, so we
// can't set window.__inboxproBridge directly — use a marker element instead.
const marker = document.createElement('meta');
marker.id = 'inboxpro-bridge-marker';
marker.setAttribute('content', 'ready');
(document.head || document.documentElement).appendChild(marker);

// Also announce via a postMessage so the page can react in real-time
window.postMessage({ type: 'inboxpro-bridge-ready' }, '*');
window.dispatchEvent(new CustomEvent('inboxpro:bridge-ready'));

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  if (!ev.data) return;

  if (ev.data.type === 'inboxpro-refresh-request') {
    chrome.runtime.sendMessage({ action: 'refreshNow' }, (response) => {
      window.postMessage({ type: 'inboxpro-refresh-result', response }, '*');
    });
  }
  if (ev.data.type === 'inboxpro-inspect-thread') {
    chrome.runtime.sendMessage(
      { action: 'inspectThread', urn: ev.data.urn },
      (response) => {
        window.postMessage({ type: 'inboxpro-inspect-result', response }, '*');
      },
    );
  }
  if (ev.data.type === 'inboxpro-refresh-thread') {
    chrome.runtime.sendMessage(
      { action: 'refreshThread', urn: ev.data.urn },
      (response) => {
        window.postMessage({
          type: 'inboxpro-refresh-thread-result',
          urn: ev.data.urn,
          response,
        }, '*');
      },
    );
  }
  if (ev.data.type === 'inboxpro-send-message') {
    chrome.runtime.sendMessage(
      { action: 'sendMessage', conversationUrn: ev.data.conversationUrn, body: ev.data.body },
      (response) => {
        window.postMessage({
          type: 'inboxpro-send-result',
          requestId: ev.data.requestId,
          response,
        }, '*');
      },
    );
  }
  // New-thread composer (LinkedIn DM or Sales Nav InMail) — routes the
  // request from new-thread-modal.tsx through to background.js.
  if (ev.data.type === 'inboxpro-new-thread-request') {
    chrome.runtime.sendMessage(
      {
        action: 'createNewThread',
        channel: ev.data.channel,
        recipientUrn: ev.data.recipientUrn,
        recipientName: ev.data.recipientName,
        subject: ev.data.subject,
        body: ev.data.body,
      },
      (response) => {
        window.postMessage({
          type: 'inboxpro-new-thread-result',
          requestId: ev.data.requestId,
          response,
        }, '*');
      },
    );
  }
  if (ev.data.type === 'inboxpro-li-api-debug') {
    chrome.runtime.sendMessage({ action: 'liApiDebugDump' }, (response) => {
      window.postMessage({ type: 'inboxpro-li-api-debug-result', response }, '*');
    });
  }
  if (ev.data.type === 'inboxpro-li-initial-sync-api') {
    chrome.runtime.sendMessage(
      { action: 'liInitialSyncApi', deepFetch: ev.data.deepFetch !== false },
      (response) => {
        window.postMessage({ type: 'inboxpro-li-initial-sync-api-result', response }, '*');
      },
    );
  }
  if (ev.data.type === 'inboxpro-typing') {
    // Fire-and-forget — don't wait for response, the UI doesn't need it
    chrome.runtime.sendMessage(
      { action: 'typing', conversationUrn: ev.data.conversationUrn },
      () => {},
    );
  }
  if (ev.data.type === 'inboxpro-full-sync-request') {
    chrome.runtime.sendMessage({ action: 'fullSync' }, (response) => {
      window.postMessage({ type: 'inboxpro-full-sync-result', response }, '*');
    });
  }
  if (ev.data.type === 'inboxpro-recover-request') {
    chrome.runtime.sendMessage({ action: 'recoverMessages' }, (response) => {
      window.postMessage({ type: 'inboxpro-recover-result', response }, '*');
    });
  }
  if (ev.data.type === 'inboxpro-enrich-request') {
    // Diagnostic — confirms bridge received the message from the page
    fetch('http://localhost:3030/api/sync-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        src: 'bridge',
        ev: 'enrich.bridgeReceived',
        hasUrl: !!ev.data.profileUrl,
        hasUrn: !!ev.data.profileUrn,
      }),
    }).catch(() => {});

    chrome.runtime.sendMessage(
      {
        action: 'enrichProfile',
        profileUrn: ev.data.profileUrn,
        profileUrl: ev.data.profileUrl,
      },
      (response) => {
        fetch('http://localhost:3030/api/sync-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            src: 'bridge',
            ev: 'enrich.bridgeResponse',
            ok: !!response?.ok,
            reason: response?.reason ?? null,
            lastErr: chrome.runtime.lastError?.message ?? null,
          }),
        }).catch(() => {});
        window.postMessage({
          type: 'inboxpro-enrich-result',
          requestId: ev.data.requestId,
          response,
        }, '*');
      },
    );
  }
  if (ev.data.type === 'inboxpro-harvest-connections-request') {
    chrome.runtime.sendMessage({ action: 'harvestConnections' }, (response) => {
      window.postMessage({ type: 'inboxpro-harvest-connections-result', response }, '*');
    });
  }
  if (ev.data.type === 'inboxpro-backfill-request') {
    chrome.runtime.sendMessage(
      { action: 'backfillCategory', category: ev.data.category || 'ARCHIVE' },
      (response) => {
        window.postMessage({ type: 'inboxpro-backfill-result', response }, '*');
      },
    );
  }
  if (ev.data.type === 'inboxpro-mirror-request') {
    chrome.runtime.sendMessage(
      { action: 'mirror', kind: ev.data.kind, urn: ev.data.urn, value: ev.data.value },
      (response) => {
        window.postMessage({
          type: 'inboxpro-mirror-result',
          requestId: ev.data.requestId,
          response,
        }, '*');
      },
    );
  }
});

// Detect extension reload (orphaned content script) and warn the page so the
// user knows to refresh. After reload, chrome.runtime.id is undefined.
function isContextValid() {
  try { return !!chrome?.runtime?.id; } catch { return false; }
}
setInterval(() => {
  if (!isContextValid()) {
    const m = document.getElementById('inboxpro-bridge-marker');
    if (m) m.setAttribute('content', 'orphaned');
    window.postMessage({ type: 'inboxpro-bridge-orphaned' }, '*');
  }
}, 5000);

// ── Background sync — bridge poll ────────────────────────────────────────────
// Every 10s, ask the background service worker to fetch LinkedIn for new/changed
// conversations and push them to the app. Uses silent:true so successful no-op
// polls don't trigger a UI "Up to date" flash — only thread-updated broadcasts
// fire when something actually changes.
// This is now the FALLBACK path. The primary realtime path is the fetch-response
// interceptor in content.js, which pushes new messages the instant LinkedIn's UI
// fetches them — sub-second when a LinkedIn tab is open.
const POLL_INTERVAL_MS = 10_000;
let pollInFlight = false;
async function poll() {
  if (pollInFlight || !isContextValid()) return;
  pollInFlight = true;
  try {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'refreshNow', silent: true }, () => resolve());
    });
  } catch {}
  pollInFlight = false;
}
setTimeout(poll, 2000);
setInterval(poll, POLL_INTERVAL_MS);

// SN poll — same idea but separate interval and action. Matches LinkedIn's
// 10s cadence; each poll is only 1 API call so total rate is 1/3 of LinkedIn's.
const SN_POLL_INTERVAL_MS = 10_000;
let snPollInFlight = false;
async function snPoll() {
  if (snPollInFlight || !isContextValid()) return;
  snPollInFlight = true;
  try {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'snRefreshNow' }, () => resolve());
    });
  } catch {}
  snPollInFlight = false;
}
setTimeout(snPoll, 3000);
setInterval(snPoll, SN_POLL_INTERVAL_MS);

// Forward background → page progress and completion events
chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === 'refresh-progress') {
    window.postMessage({ type: 'inboxpro-refresh-progress', message: message.message }, '*');
  }
  if (message?.action === 'refresh-complete') {
    window.postMessage({ type: 'inboxpro-refresh-result', response: message.result }, '*');
  }
  if (message?.action === 'thread-updated') {
    window.postMessage({
      type: 'inboxpro-thread-updated',
      urn: message.urn,
      count: message.count,
    }, '*');
  }
  if (message?.action === 'li-api-sync-progress') {
    window.postMessage({ type: 'inboxpro-li-api-sync-progress', progress: message.progress }, '*');
  }
});
