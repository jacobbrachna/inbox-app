// Runs in LinkedIn's MAIN world — hooks fetch to capture messaging API responses
// AND action requests (delete, archive, etc.) so we can mirror them later.

(() => {
  if (window.__inboxproPatched) return;
  window.__inboxproPatched = true;

  // Beacon: confirms injected.js is running on this page. Fires once per load.
  // Routed via postMessage → content.js → /api/sync-log because direct fetch
  // from MAIN world can hit CORS even though the route allows *.
  try {
    window.postMessage({
      __inboxproPageLoaded: true,
      host: location.host,
      path: location.pathname.slice(0, 120),
    }, '*');
  } catch (e) {}

  const isMessagingURL = (url) =>
    typeof url === 'string' &&
    (url.includes('voyagerMessagingGraphQL/graphql') ||
      url.includes('/sales-api/salesApiInboxConversations') ||
      url.includes('/sales-api/salesApiMessagingThreads') ||
      url.includes('messengerConversations') ||
      url.includes('messengerMessages'));

  // Also intercept profile fetches — these carry publicIdentifier on profile
  // entities, which we use to back-fill /in/<slug>/ URLs on participants.
  const isProfileURL = (url) =>
    typeof url === 'string' &&
    (url.includes('voyagerIdentityDashProfiles') ||
      url.includes('identity/profiles') ||
      url.includes('/voyager/api/identity/dash/profiles') ||
      url.includes('voyagerIdentityDashProfileCards') ||
      url.includes('voyagerIdentityDashProfileViews'));

  // Sales Navigator — different API surface entirely. Match generously: any
  // URL containing "sales-api", "sales-mvc", "voyagerSales", "salesApi", or
  // "salesnavigator". URLs may be relative (XHR often uses /sales-api/...)
  // so we don't require the host to be in the string.
  const isSalesNavURL = (url) => {
    if (typeof url !== 'string') return false;
    return (
      url.includes('/sales-api/') ||
      url.includes('/sales-mvc/') ||
      url.includes('voyagerSales') ||
      url.includes('salesApi') ||
      url.includes('salesnavigator')
    );
  };

  // Diagnostic: log any unique SN URL we see — via postMessage to content.js
  // (which posts to /api/sync-log with proper extension permissions).
  const seenSnUrls = new Set();
  function logSnUrl(url, method, status) {
    if (seenSnUrls.has(url)) return;
    seenSnUrls.add(url);
    try {
      window.postMessage({
        __inboxproSnUrl: true,
        method: method || 'GET',
        url: url.slice(0, 4000),
        status: status ?? null,
      }, '*');
    } catch {}
  }

  // Diagnostic: log every UNIQUE LinkedIn voyager messaging URL we see.
  // Routes through the same SN-URL beacon so it ends up in the diag log.
  const seenLiMsgUrls = new Set();
  function logLiMsgUrl(url, method, status) {
    if (typeof url !== 'string') return;
    if (!url.includes('messenger') && !url.includes('voyagerMessaging')) return;
    if (seenLiMsgUrls.has(url)) return;
    seenLiMsgUrls.add(url);
    try {
      window.postMessage({
        __inboxproSnUrl: true,
        method: method || 'GET',
        url: 'li-msg: ' + url.slice(0, 4000),
        status: status ?? null,
      }, '*');
    } catch {}
  }

  // Diagnostic: log a sample (first 8) of EVERY URL our patched fetch/XHR sees.
  // If we see nothing here when on a LinkedIn page, the page is bypassing
  // window.fetch / XMLHttpRequest entirely (worker, iframe, or pre-captured ref).
  let tapsLogged = 0;
  function tapAllUrls(url, source) {
    if (tapsLogged > 8) return;
    tapsLogged++;
    try {
      window.postMessage({
        __inboxproTap: true,
        source,
        url: typeof url === 'string' ? url.slice(0, 220) : String(url).slice(0, 220),
      }, '*');
    } catch {}
  }

  // Catch-all flag: any URL we want to harvest entities from.
  const isHarvestURL = (url) => isMessagingURL(url) || isProfileURL(url) || isSalesNavURL(url);

  // Capture any messaging-related action (POST/DELETE/PATCH/PUT) — these are
  // mutations like delete-conversation, archive, mark-read, send.
  const isActionURL = (url, method) => {
    if (typeof url !== 'string') return false;
    if (!url.includes('linkedin.com/voyager/api/')) return false;
    if (!['POST', 'DELETE', 'PATCH', 'PUT'].includes((method || '').toUpperCase())) return false;
    return (
      url.includes('Messag') || url.includes('messag') ||
      url.includes('Conversation') || url.includes('conversation') ||
      url.includes('Inbox') || url.includes('inbox')
    );
  };

  // Sales Navigator action URLs — POST createMessage, archive, mark-read, etc.
  // Broad match: any non-GET on a sales-api messaging path. SN uses POST, PATCH,
  // DELETE depending on the action.
  const isSnActionURL = (url, method) => {
    if (typeof url !== 'string') return false;
    const m = (method || '').toUpperCase();
    if (m === 'GET' || m === 'OPTIONS' || m === 'HEAD') return false;
    if (!url.includes('/sales-api/')) return false;
    return (
      url.includes('MessageAction') ||
      url.includes('MessagingThread') ||
      url.includes('messagingThread') ||
      url.includes('Message') ||
      url.includes('message')
    );
  };

  function postIntercept(payload) {
    try { window.postMessage(payload, '*'); } catch (e) {}
  }

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    const init = args[1] || (typeof args[0] === 'object' ? args[0] : {});
    const method = (init?.method || 'GET').toUpperCase();
    const reqBody = init?.body;

    // Log the request side BEFORE the response (so action captures happen even on 4xx)
    if (isActionURL(url, method) || isSnActionURL(url, method)) {
      let bodyText = null;
      try {
        if (typeof reqBody === 'string') bodyText = reqBody;
        else if (reqBody && typeof reqBody.text === 'function') bodyText = await reqBody.text().catch(() => null);
        else if (reqBody instanceof FormData) {
          bodyText = JSON.stringify(Object.fromEntries(reqBody.entries()));
        }
      } catch (e) {}
      postIntercept({
        __inboxproAction: true,
        method,
        url,
        body: bodyText,
      });
    }

    if (url && (url.includes('linkedin.com') || url.startsWith('/'))) tapAllUrls(url, 'fetch');
    const res = await origFetch.apply(this, args);
    try {
      if (isSalesNavURL(url)) logSnUrl(url, method, res.status);
      logLiMsgUrl(url, method, res.status);
      if (isHarvestURL(url) && res.ok) {
        const clone = res.clone();
        clone.text().then((text) => {
          postIntercept({ __inboxproIntercept: true, url, body: text });
        }).catch(() => {});
      }
      // Also forward the response status of action requests, so we can verify
      if (isActionURL(url, method)) {
        postIntercept({
          __inboxproActionResponse: true,
          method,
          url,
          status: res.status,
        });
      }
      // SN action — POST createMessage etc. Trigger an inbox refresh.
      if (isSnActionURL(url, method) && res.ok) {
        postIntercept({ __inboxproSnAction: true, url, method, status: res.status });
      }
    } catch (e) {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__inboxproUrl = url;
    this.__inboxproMethod = (method || '').toUpperCase();
    if (url && (String(url).includes('linkedin.com') || String(url).startsWith('/'))) {
      tapAllUrls(url, 'xhr');
    }
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (isActionURL(this.__inboxproUrl, this.__inboxproMethod) ||
        isSnActionURL(this.__inboxproUrl, this.__inboxproMethod)) {
      let bodyText = null;
      try { bodyText = typeof body === 'string' ? body : null; } catch (e) {}
      postIntercept({
        __inboxproAction: true,
        method: this.__inboxproMethod,
        url: this.__inboxproUrl,
        body: bodyText,
      });
    }
    this.addEventListener('load', () => {
      const u = this.__inboxproUrl;
      try {
        if (isSalesNavURL(u)) {
          logSnUrl(u, this.__inboxproMethod, this.status);
        }
        logLiMsgUrl(u, this.__inboxproMethod, this.status);
      } catch {}
      // Intercept body. SN sets responseType='blob' on its XHRs, so
      // `responseText` throws InvalidStateError. We read `this.response`
      // instead and convert to text based on responseType.
      try {
        if (isHarvestURL(u) && this.status >= 200 && this.status < 300) {
          const rt = this.responseType;
          const finish = (body) => {
            postIntercept({ __inboxproIntercept: true, url: u, body });
          };
          if (rt === '' || rt === 'text') {
            try { finish(this.responseText); } catch {}
          } else if (rt === 'json') {
            try { finish(JSON.stringify(this.response)); } catch {}
          } else if (rt === 'blob' && this.response) {
            // Blob → text is async. Use FileReader or .text() (newer browsers).
            const blob = this.response;
            if (typeof blob.text === 'function') {
              blob.text().then(finish).catch(() => {});
            } else {
              const fr = new FileReader();
              fr.onload = () => finish(String(fr.result || ''));
              fr.readAsText(blob);
            }
          } else if (rt === 'arraybuffer' && this.response) {
            try { finish(new TextDecoder().decode(this.response)); } catch {}
          }
        }
      } catch {}
      try {
        if (isSnActionURL(u, this.__inboxproMethod) && this.status >= 200 && this.status < 300) {
          postIntercept({ __inboxproSnAction: true, url: u, method: this.__inboxproMethod, status: this.status });
        }
        if (isActionURL(u, this.__inboxproMethod)) {
          postIntercept({
            __inboxproActionResponse: true,
            method: this.__inboxproMethod,
            url: u,
            status: this.status,
          });
        }
      } catch {}
    });
    return origSend.call(this, body);
  };

  // ── WebSocket hook ──────────────────────────────────────────────────────
  // LinkedIn pushes new-message notifications over WebSocket (realtime). The
  // REST conversation-list endpoint lags behind these events. By hooking
  // WebSocket we can fire an immediate sync the moment LinkedIn sees activity,
  // without needing a LinkedIn tab visible or the user clicking anything.
  // Track open WebSockets keyed by URL so we can resend later (typing mirror).
  window.__inboxproOpenWS = window.__inboxproOpenWS || new Map();

  const OrigWS = window.WebSocket;
  if (OrigWS) {
    window.WebSocket = function PatchedWS(url, protocols) {
      const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
      try {
        const urlStr = String(url);
        // Listen on any linkedin.com WS — if LinkedIn moves messaging back to
        // main-context, we want to catch it without depending on a specific
        // URL token like "realtime" or "messaging".
        const isLinkedInRealtime = urlStr.includes('linkedin.com');

        if (isLinkedInRealtime) {
          // Stash the live WebSocket so we can send through it later
          window.__inboxproOpenWS.set(urlStr, ws);
          ws.addEventListener('close', () => window.__inboxproOpenWS.delete(urlStr));

          // Hook outbound sends — discover SN's typing payload here.
          const origSend = ws.send.bind(ws);
          ws.send = function patchedSend(data) {
            try {
              if (typeof data === 'string' && data.length < 2000) {
                // Heuristic: typing/realtime events tend to be short JSON strings.
                window.postMessage({
                  __inboxproWsSend: true,
                  url: urlStr,
                  preview: data.slice(0, 500),
                  bytes: data.length,
                }, '*');
              }
            } catch {}
            return origSend(data);
          };
        }

        if (isLinkedInRealtime) {
          ws.addEventListener('message', (ev) => {
            try {
              const d = ev.data;
              if (typeof d !== 'string') return;

              // LinkedIn voyager realtime
              const isLiMsg =
                d.includes('messagingMessage') ||
                d.includes('msg_message') ||
                d.includes('msg_conversation');
              // Sales Navigator realtime — different URN prefix family
              const isSnMsg =
                d.includes('salesMessagingMessage') ||
                d.includes('fs_salesMessagingThread') ||
                d.includes('fs_salesMessagingMessage') ||
                d.includes('salesMessagingThread');

              if (!isLiMsg && !isSnMsg) return;

              // Extract any URNs present so we can targeted-refresh.
              const liUrns = d.match(/urn:li:msg_conversation:\([^)]+\)/g) || [];
              const snUrns = d.match(/urn:li:fs_salesMessagingThread:[^,"\s)]+/g) || [];

              window.postMessage({
                __inboxproRealtime: true,
                url: urlStr,
                source: isSnMsg ? 'sn' : 'li',
                convUrns: [...new Set(liUrns)],
                snUrns: [...new Set(snUrns)],
                preview: d.slice(0, 240),
              }, '*');
            } catch (e) {}
          });
        }
      } catch (e) {}
      return ws;
    };
    // Preserve static props
    for (const k of Object.keys(OrigWS)) {
      try { window.WebSocket[k] = OrigWS[k]; } catch (e) {}
    }
    window.WebSocket.prototype = OrigWS.prototype;
  }

  console.log('[InboxPro] fetch + WebSocket hooks installed');
})();
