// Content script — captures LinkedIn's messaging API responses, resolves URN refs,
// and bulk-fetches messages. Designed for inboxes with 1000+ threads.

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function injectScript() {
  return new Promise((resolve) => {
    if (document.getElementById('inboxpro-injected')) return resolve();
    const s = document.createElement('script');
    s.id = 'inboxpro-injected';
    s.src = chrome.runtime.getURL('injected.js');
    s.onload = () => resolve();
    (document.head || document.documentElement).appendChild(s);
  });
}

// Inject hook IMMEDIATELY (at document_start) so we catch LinkedIn's initial
// fetches that happen before the user clicks Sync Now.
injectScript();

// Kick off passive auto-sync as soon as the page is interactive. The interval
// itself is harmless (it no-ops when there's nothing new) and self-recovers if
// the InboxPro app isn't running yet.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => ensureAutoSyncStarted());
} else {
  // ensureAutoSyncStarted is defined below; defer so the function exists.
  setTimeout(() => ensureAutoSyncStarted(), 0);
}

// ── State ──────────────────────────────────────────────────────────────────────
const conversationsByUrn = new Map();   // entityUrn → conversation object
const messagesByConvKey = new Map();    // normalized conv key → Message[]
const entitiesByUrn = new Map();        // entityUrn → any LinkedIn entity (profiles, etc.)
const messageURLPatterns = [];
let myProfileUrn = '';                  // resolved during sync

// ── Profile capture consent (gates SDUI POSTs on /in/* pages) ──────────────
// Re-evaluated on every SPA navigation between profiles. Three outcomes:
//   • App-initiated tab → POST silently (full capture flow active)
//   • Messageable contact (already has conversation) → POST silently
//   • Stranger → SKIP POST (wait for "Import to InboxPro" button click)
//
// LinkedIn's React app does SPA navigation between /in/<slug> pages via
// pushState — content scripts don't re-execute, so we maintain a cache
// keyed by slug and refresh it on each URL change.
const sduiConsentBySlug = new Map(); // slug → Promise<{ allowed, reason }>

function computeSduiConsent(slug) {
  return (async () => {
    let appInitiated = false;
    try {
      const resp = await new Promise((resolve) => {
        try { chrome.runtime.sendMessage({ action: 'is-app-initiated' }, (r) => resolve(r)); }
        catch { resolve(null); }
      });
      appInitiated = !!resp?.initiated;
    } catch {}
    if (appInitiated) return { allowed: true, reason: 'app-initiated' };

    try {
      const r = await fetch(`http://localhost:3030/api/contacts/by-slug/${encodeURIComponent(slug)}/status`);
      if (r.ok) {
        const j = await r.json();
        if (j.messageable) return { allowed: true, reason: 'messageable' };
      }
    } catch {}
    return { allowed: false, reason: 'stranger' };
  })();
}

function getCurrentSduiConsent() {
  const m = location.pathname.match(/^\/in\/([^/]+)/);
  if (!m) return Promise.resolve({ allowed: false, reason: 'not-profile' });
  const slug = m[1];
  if (!sduiConsentBySlug.has(slug)) sduiConsentBySlug.set(slug, computeSduiConsent(slug));
  return sduiConsentBySlug.get(slug);
}

// ── Auto-sync state ───────────────────────────────────────────────────────────
// The canonical sync path is the 10s poll in bridge.js. This flag just guards
// the one-time load of "known conv URNs" used to gate notifications.
let autoSyncStarted = false;
const INBOXPRO_URL = 'http://localhost:3030';

// ── Notification throttling ────────────────────────────────────────────────────
// notifiedMsgUrns prevents the same message from notifying twice; we also
// group bursts (>3 messages in 10s from the same conversation) into one.
const notifiedMsgUrns = new Set();
const recentNotifyByConv = new Map(); // convUrn → [timestamps]
const pendingGroupByConv = new Map(); // convUrn → { timer, count, lastMsg, senderName }
// Conversations that existed in the app BEFORE this content-script instance
// started — used to gate notifications to only fire for convs already in DB.
const knownConvUrnsAtStart = new Set();
let knownConvsLoaded = false;

// ── Type guards ────────────────────────────────────────────────────────────────
function getType(e) { return e?.$type || ''; }

function isConversation(e) {
  if (!e || typeof e !== 'object') return false;
  const urn = e.entityUrn || '';
  const type = getType(e);
  if (type.includes('MailboxCount') || type.includes('QuickReply') ||
      type.includes('SeenReceipt') || type.includes('TypingIndicator')) return false;
  return (
    urn.includes('messagingConversation') ||
    urn.includes('msg_conversation') ||
    type.includes('Conversation') ||
    !!e.conversationParticipants ||
    !!e['*conversationParticipants']
  );
}

function isMessage(e) {
  if (!e || typeof e !== 'object') return false;
  const urn = e.entityUrn || '';
  const type = getType(e);
  return (
    urn.includes('messagingMessage') ||
    urn.includes('msg_message') ||
    type.includes('messenger.Message') ||
    (e.deliveredAt != null && (e.body || e.messageBodyRenderFormat))
  );
}

function isProfile(e) {
  if (!e || typeof e !== 'object') return false;
  const urn = e.entityUrn || '';
  const type = getType(e);
  return (
    urn.includes('fsd_profile') ||
    urn.includes('miniProfile') ||
    type.includes('MessagingParticipant') ||
    (e.firstName && e.lastName) ||
    type.includes('Profile')
  );
}

// Extract a stable key from any conversation URN format
// e.g. "urn:li:fsd_messagingConversation:(2-Y2...)" → "2-Y2..."
function convKeyFromUrn(urn) {
  if (!urn) return '';
  const m = urn.match(/\(([^)]+)\)/);
  return m ? m[1] : urn;
}

// ── Walking captured responses ─────────────────────────────────────────────────
function walkAndHarvest(json, url) {
  let added = { convs: 0, msgs: 0, entities: 0 };
  // Track the actual objects that were newly added in this pass so callers
  // can react (e.g. desktop notifications for new inbound messages).
  const newConvs = [];
  const newMsgs = []; // each entry: { msg, convUrn }
  const stack = [json];
  const visited = new WeakSet();

  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (visited.has(v)) continue;
    visited.add(v);

    if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
      continue;
    }

    // Index every object with an entityUrn — this gives us the entity dictionary
    if (typeof v.entityUrn === 'string' && v.entityUrn.length > 0) {
      if (!entitiesByUrn.has(v.entityUrn)) {
        entitiesByUrn.set(v.entityUrn, v);
        added.entities++;
      }
      // Conversations
      if (isConversation(v) && !conversationsByUrn.has(v.entityUrn)) {
        // Tag source based on which API surface fed us the data so the import
        // handler routes Sales Nav convs through transformConversations(...,'sales_nav',...).
        // SN URLs are typically relative (/sales-api/...) — match on path patterns
        // without requiring the host string to be present.
        const isSn = /\/sales-api\/|\/sales-mvc\/|voyagerSales|salesApi|salesnavigator/i.test(url);
        const src = isSn ? 'sn' : 'li';
        conversationsByUrn.set(v.entityUrn, { ...v, _src: src, _url: url });
        newConvs.push(v);
        added.convs++;
      }
      // Messages
      if (isMessage(v)) {
        // Normalize conversation key from various possible fields — store under
        // BOTH the full URN and the inner-paren key so lookups can match either
        const cUrn = v.conversation?.entityUrn ||
          v.conversationUrn ||
          v['*conversation'] ||
          v.backendConversationUrn ||
          extractConvKeyFromMessageUrn(v.entityUrn);
        const innerKey = convKeyFromUrn(cUrn);
        const indexKeys = [cUrn, innerKey].filter(Boolean);
        let addedThisMsg = false;
        for (const key of indexKeys) {
          if (!messagesByConvKey.has(key)) messagesByConvKey.set(key, []);
          const arr = messagesByConvKey.get(key);
          if (!arr.some((x) => x.entityUrn === v.entityUrn)) {
            arr.push(v);
            added.msgs++;
            addedThisMsg = true;
          }
        }
        if (addedThisMsg) {
          newMsgs.push({ msg: v, convUrn: cUrn || '' });
        }
      }
    }

    // Detect "me" — LinkedIn responses sometimes include a viewer/host profile
    if (!myProfileUrn) {
      if (typeof v.hostIdentityUrn === 'string') myProfileUrn = v.hostIdentityUrn;
      else if (typeof v.viewerUrn === 'string') myProfileUrn = v.viewerUrn;
    }

    // Recurse
    for (const val of Object.values(v)) {
      if (val && typeof val === 'object') stack.push(val);
    }
  }

  added.newConvs = newConvs;
  added.newMsgs = newMsgs;
  return added;
}

// Message URNs sometimes embed the conversation key:
// urn:li:msg_message:(urn:li:msg_conversation:(2-X),3-Y)
function extractConvKeyFromMessageUrn(urn) {
  if (!urn) return '';
  const m = urn.match(/msg_conversation:\(([^)]+)\)/);
  return m ? `urn:li:msg_conversation:(${m[1]})` : '';
}

// ── Realtime WebSocket trigger ───────────────────────────────────────────────
// LinkedIn's realtime WebSocket pushes message events with the conversation URN
// embedded. We extract that URN and fire a targeted refreshThread (1 fetch) —
// far faster than a full conv-list sync.
// Fire refreshes on WebSocket activity. Strategy:
//   1. Immediate refreshThread for each URN (fast path — usually catches it)
//   2. Delayed refreshNow at 1.5s (catches new convs + handles LinkedIn's
//      indexing lag between realtime push and REST availability)
//   3. Dedupe bursts of the same URN within 2s
const firedRecently = new Set();
let fullSyncScheduled = false;

function fireThreadRefresh(urn) {
  if (firedRecently.has(urn)) return;
  firedRecently.add(urn);
  setTimeout(() => firedRecently.delete(urn), 2000);
  console.log('[InboxPro realtime] refreshThread:', urn.slice(-40));
  chrome.runtime.sendMessage({ action: 'refreshThread', urn }).catch(() => {});
}

function scheduleFullSync() {
  if (fullSyncScheduled) return;
  fullSyncScheduled = true;
  setTimeout(() => {
    fullSyncScheduled = false;
    console.log('[InboxPro realtime] follow-up refreshNow');
    chrome.runtime.sendMessage({ action: 'refreshNow' }).catch(() => {});
  }, 1500);
}

// WebSocket realtime trigger — left in place silently. LinkedIn currently
// runs messaging realtime in a SharedWorker, so the page-level window.WebSocket
// hook never sees it. The bridge poll (2s) is the primary sync path. If
// LinkedIn ever moves messaging back to main-context JS, this will start firing
// automatically.
window.addEventListener('message', (ev) => {
  if (!ev.data || !ev.data.__inboxproRealtime) return;
  const urns = Array.isArray(ev.data.convUrns) ? ev.data.convUrns : [];
  const snUrns = Array.isArray(ev.data.snUrns) ? ev.data.snUrns : [];
  const source = ev.data.source || 'li';
  fetch('http://localhost:3030/api/sync-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      src: 'content', ev: 'websocket.event',
      source, urnCount: urns.length, snUrnCount: snUrns.length,
      preview: (ev.data.preview || '').slice(0, 120),
    }),
  }).catch(() => {});
  // SN realtime: trigger an immediate SN background sync — service worker
  // hits SN's first page and the parser upserts whatever's new.
  if (source === 'sn') {
    chrome.runtime.sendMessage({ action: 'snRefreshNow' }).catch(() => {});
    return;
  }
  // LinkedIn: existing per-conv refresh path
  if (urns.length === 0) return;
  for (const urn of urns) fireThreadRefresh(urn);
  scheduleFullSync();
});

// WebSocket outbound captures — useful for discovering payloads (e.g. SN typing)
window.addEventListener('message', (ev) => {
  if (!ev.data || !ev.data.__inboxproWsSend) return;
  fetch('http://localhost:3030/api/sync-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      src: 'content', ev: 'ws.send',
      url: (ev.data.url || '').slice(0, 120),
      bytes: ev.data.bytes ?? 0,
      preview: ev.data.preview || '',
    }),
  }).catch(() => {});
});

// SN action observed (e.g. POST createMessage) — SN doesn't re-fetch its own
// inbox after these, so we trigger an immediate snRefreshNow to mirror the
// state into InboxPro within seconds rather than waiting for the next poll.
window.addEventListener('message', (ev) => {
  if (!ev.data || !ev.data.__inboxproSnAction) return;
  fetch('http://localhost:3030/api/sync-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      src: 'content', ev: 'sn.action.observed',
      url: (ev.data.url || '').slice(0, 200), method: ev.data.method, status: ev.data.status,
    }),
  }).catch(() => {});
  chrome.runtime.sendMessage({ action: 'snRefreshNow' }).catch(() => {});
});

// Extract a LinkedIn category (PRIMARY_INBOX/OTHER/ARCHIVE/...) from a captured
// URL. LinkedIn's conv-list query embeds it as `category:ARCHIVE` in the
// variables block. Returns '' when the URL isn't a category query (e.g. it's
// a single-conv messages fetch).
function categoryFromUrl(url) {
  const m = url.match(/conversationCategoryPredicate:\(category:([A-Z_]+)\)/);
  return m ? m[1] : '';
}

// Beacons from injected.js — relay to our sync log so we can diagnose
// when the page-context script is alive on a given LinkedIn page (esp. SN).
window.addEventListener('message', (ev) => {
  if (ev.source !== window || !ev.data) return;
  if (ev.data.__inboxproPageLoaded) {
    fetch('http://localhost:3030/api/sync-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        src: 'injected', ev: 'page.loaded',
        host: ev.data.host, path: ev.data.path,
      }),
    }).catch(() => {});
  }
  if (ev.data.__inboxproSnUrl) {
    fetch('http://localhost:3030/api/sync-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        src: 'sn-probe', ev: 'sn.urlSeen',
        method: ev.data.method, url: ev.data.url, status: ev.data.status,
      }),
    }).catch(() => {});
  }
  if (ev.data.__inboxproTap) {
    fetch('http://localhost:3030/api/sync-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        src: 'tap', ev: 'http.observed',
        source: ev.data.source, url: ev.data.url,
      }),
    }).catch(() => {});
  }
});

// ── Listen to intercepted responses ────────────────────────────────────────────
window.addEventListener('message', (ev) => {
  if (!ev.data || !ev.data.__inboxproIntercept) return;
  const url = ev.data.url || '';

  if (url.includes('messengerMessages.') && !messageURLPatterns.includes(url)) {
    messageURLPatterns.push(url);
  }

  // LinkedIn profile responses — pass body to background so it can run
  // extractFromVoyager (rich fields) and forward to /api/profile-capture/voyager-tap.
  // Triggers passively whenever LinkedIn's UI loads profile data: visits,
  // hovers, hidden-tab enrichment, etc. Throttled so we don't spam.
  const isLiProfileUrl = (
    url.includes('voyagerIdentityDashProfiles') ||
    url.includes('voyagerIdentityDashProfileCards') ||
    url.includes('voyagerIdentityDashProfileViews') ||
    url.includes('/voyager/api/identity/profiles')
  );
  if (isLiProfileUrl && typeof ev.data.body === 'string' && ev.data.body.length > 100) {
    try {
      chrome.runtime.sendMessage({
        action: 'voyagerProfileTap',
        url,
        body: ev.data.body,
      });
    } catch {
      // extension context invalidated (e.g. reloaded); silent
    }
  }

  // SDUI profile components — modern LinkedIn rendering path. Forward raw
  // body to the debug endpoint so we can inspect the shape and build a parser.
  const isSduiProfile = (
    url.includes('/flagship-web/rsc-action/actions/component') &&
    url.includes('componentId=com.linkedin.sdui.generated.profile')
  );
  if (isSduiProfile && typeof ev.data.body === 'string' && ev.data.body.length > 100) {
    // Pull the slug from current page URL — content scripts only run on
    // linkedin.com so location.pathname is reliable.
    const slugMatch = location.pathname.match(/^\/in\/([^/]+)/);
    const profileSlug = slugMatch ? slugMatch[1] : null;
    const bodySlice = ev.data.body.slice(0, 200_000);
    // Await per-slug consent verdict before POSTing. The cache key is the
    // slug from current URL — if the user is on the stranger's profile,
    // we get the stranger verdict (not whoever was visited before).
    getCurrentSduiConsent().then((c) => {
      if (!c?.allowed) return;
      fetch('http://localhost:3030/api/profile-sdui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, profileSlug, body: bodySlice }),
      }).catch(() => {});
    });
  }

  // Sales Navigator profile endpoint — headlines/avatars/etc.
  // When the user visits a lead profile page in SN, this fires.
  if (url.includes('/sales-api/salesApiProfiles')) {
    fetch('http://localhost:3030/api/import/sales-nav-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: ev.data.body }),
    })
      .then((r) => r.json().catch(() => ({})))
      .then((result) => {
        fetch('http://localhost:3030/api/sync-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            src: 'content', ev: 'sn.profile.passive',
            patched: result?.patched ?? 0,
            name: result?.name || null,
            headline: result?.headline ? result.headline.slice(0, 60) : null,
          }),
        }).catch(() => {});
      })
      .catch(() => {});
    return;
  }

  // Sales Navigator messaging threads use a different response shape that
  // walkAndHarvest can't reliably parse (different URN types, top-level id +
  // messages array instead of voyager's data + included). Route these to a
  // dedicated server-side parser and skip walkAndHarvest for them.
  if (url.includes('/sales-api/salesApiMessagingThreads')) {
    // Single-thread responses (path contains /2-...) have shape
    // { data: { <thread> }, included: [...] } while list responses have
    // { data: { elements: [...] }, included: [...] }. The parser expects the
    // list shape — wrap single-thread responses to match.
    const isSingleThread = /\/salesApiMessagingThreads\/2-/.test(url);
    let body = ev.data.body;
    if (isSingleThread) {
      try {
        const j = JSON.parse(body);
        if (j?.data && !Array.isArray(j.data.elements) && j.data.id) {
          j.data = { elements: [j.data] };
          body = JSON.stringify(j);
        }
      } catch {}
    }
    // Confirm the intercept reached content.js — separate from
    // sn.msgs.imported which fires after the server parses the body.
    fetch('http://localhost:3030/api/sync-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        src: 'content',
        ev: 'sn.msgs.intercepted',
        bytes: (ev.data.body || '').length,
        single: isSingleThread,
      }),
    }).catch(() => {});
    fetch('http://localhost:3030/api/import/sales-nav-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    })
      .then((r) => r.json().catch(() => ({})))
      .then((result) => {
        // Tally broadcast for sn-sync-button.js to wait on completion.
        try {
          window.postMessage({
            __inboxproSnImportTally: true,
            threads: result?.threadsFound ?? 0,
            inserted: result?.inserted ?? 0,
            convsHeadlined: result?.convsHeadlined ?? 0,
          }, '*');
        } catch {}
        fetch('http://localhost:3030/api/sync-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            src: 'content',
            ev: 'sn.msgs.imported',
            threads: result?.threadsFound ?? 0,
            convsTouched: result?.convsTouched ?? 0,
            found: result?.messagesFound ?? 0,
            inserted: result?.inserted ?? 0,
            headlined: result?.convsHeadlined ?? 0,
            skipped: result?.skipped ?? null,
            reason: result?.reason || null,
            rootKeys: result?.rootKeys || null,
            error: result?.error || null,
          }),
        }).catch(() => {});
      })
      .catch((err) => {
        fetch('http://localhost:3030/api/sync-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            src: 'content',
            ev: 'sn.msgs.error',
            error: err?.message || String(err),
          }),
        }).catch(() => {});
      });
    return;
  }

  let j;
  try { j = JSON.parse(ev.data.body); } catch { return; }

  // Snapshot of profile entities BEFORE the walk so we can tell what's new.
  const profileUrnsBefore = new Set();
  for (const k of entitiesByUrn.keys()) {
    if (k.includes('fsd_profile') || k.includes('miniProfile')) profileUrnsBefore.add(k);
  }

  const added = walkAndHarvest(j, url);

  // If we just harvested NEW profile entities with publicIdentifier, push
  // them to /api/import so the server can backfill participants' profileUrl.
  // This is the passive enrichment path — fires whenever LinkedIn's own UI
  // touches a profile, without needing any user action in InboxPro.
  let newProfileEntitiesWithSlug = 0;
  const profileEntitiesPayload = {};
  for (const [k, e] of entitiesByUrn) {
    if (!k.includes('fsd_profile') && !k.includes('miniProfile')) continue;
    if (profileUrnsBefore.has(k)) continue; // already seen
    const slug =
      (typeof e?.publicIdentifier === 'string' && e.publicIdentifier) ||
      (typeof e?.miniProfile?.publicIdentifier === 'string' && e.miniProfile.publicIdentifier) ||
      '';
    if (slug) {
      profileEntitiesPayload[k] = e;
      newProfileEntitiesWithSlug++;
    }
  }
  if (newProfileEntitiesWithSlug > 0) {
    fetch('http://localhost:3030/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversations: [],
        messages: {},
        entities: profileEntitiesPayload,
        myProfileUrn,
      }),
    })
      .then(() => {
        fetch('http://localhost:3030/api/sync-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            src: 'content',
            ev: 'enrich.passivePush',
            profiles: newProfileEntitiesWithSlug,
          }),
        }).catch(() => {});
      })
      .catch(() => {});
  }

  if (added.convs > 0 || added.msgs > 0) {
    chrome.runtime.sendMessage({
      action: 'progress',
      message: `${conversationsByUrn.size} convs · ${countMessages()} msgs`,
    }).catch(() => {});

    // Fire notifications for newly-arrived inbound messages.
    if (Array.isArray(added.newMsgs) && added.newMsgs.length > 0) {
      maybeNotifyFromNewMessages(added.newMsgs);
    }

    // Ensure the passive auto-sync interval is running.
    ensureAutoSyncStarted();

    // PRIMARY REALTIME PATH: queue new convs/msgs to be pushed to /api/import.
    // Debounced ~300ms so a burst of LinkedIn fetches (which often arrive in
    // quick succession) coalesce into one POST.
    // Tag with category extracted from the URL so /api/import can mirror
    // LinkedIn's archive state — without this tag the import preserves the
    // local read/unread state and never learns the conv was archived.
    const category = categoryFromUrl(url);
    queueRealtimePush(added.newConvs || [], added.newMsgs || [], category);
  }
});

function countMessages() {
  let n = 0;
  for (const arr of messagesByConvKey.values()) n += arr.length;
  return n;
}

// ── Realtime push: fetch-hook → /api/import ─────────────────────────────────
// Whenever walkAndHarvest finds new convs or msgs in an intercepted LinkedIn
// response, we accumulate them here and flush to InboxPro on a short debounce.
// This is what makes the inbox feel realtime when a LinkedIn tab is open.
const pendingNewConvCategoryByUrn = new Map();   // convUrn → category (or '' if unknown)
const pendingNewMsgsByConv = new Map();          // convUrn → Map<msgUrn, msg>
let pendingPushTimer = null;
const PUSH_DEBOUNCE_MS = 300;

function queueRealtimePush(newConvs, newMsgs, category) {
  for (const c of newConvs) {
    if (!c?.entityUrn) continue;
    // Latest category wins. A conv showing up in PRIMARY_INBOX after being in
    // ARCHIVE means LinkedIn moved it; we want the move to mirror.
    const existing = pendingNewConvCategoryByUrn.get(c.entityUrn);
    pendingNewConvCategoryByUrn.set(c.entityUrn, category || existing || '');
  }
  for (const { msg, convUrn } of newMsgs) {
    if (!msg?.entityUrn || !convUrn) continue;
    if (!pendingNewMsgsByConv.has(convUrn)) pendingNewMsgsByConv.set(convUrn, new Map());
    pendingNewMsgsByConv.get(convUrn).set(msg.entityUrn, msg);
  }
  if (pendingPushTimer) return;
  pendingPushTimer = setTimeout(flushRealtimePush, PUSH_DEBOUNCE_MS);
}

async function flushRealtimePush() {
  pendingPushTimer = null;
  if (pendingNewConvCategoryByUrn.size === 0 && pendingNewMsgsByConv.size === 0) return;

  // Snapshot + clear the queues so a concurrent harvest can start filling again.
  const convCategoryMap = new Map(pendingNewConvCategoryByUrn);
  pendingNewConvCategoryByUrn.clear();
  const msgsByConv = new Map(pendingNewMsgsByConv);
  pendingNewMsgsByConv.clear();

  // Build conversations, tagging each with its category (when known) so
  // /api/import can mirror LinkedIn's archive state.
  const conversations = [];
  for (const [urn, category] of convCategoryMap) {
    const conv = conversationsByUrn.get(urn);
    if (!conv) continue;
    conversations.push(category ? { ...conv, _sourceCategory: category } : conv);
  }

  const messages = {};
  for (const [convUrn, msgMap] of msgsByConv) {
    messages[convUrn] = [...msgMap.values()];
  }

  // Pick out the profile/participant entities referenced by what we're pushing.
  // Keeps the payload small — no need to send the whole entity dictionary.
  const entities = {};
  for (const [urn, e] of entitiesByUrn) {
    if (urn.includes('fsd_profile') || urn.includes('miniProfile') ||
        urn.includes('msg_messagingParticipant')) {
      entities[urn] = e;
    }
  }

  const convCount = conversations.length;
  const msgCount = Object.values(messages).reduce((a, b) => a + b.length, 0);

  try {
    await fetch('http://localhost:3030/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversations,
        messages,
        entities,
        myProfileUrn,
      }),
    });
    fetch('http://localhost:3030/api/sync-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        src: 'content',
        ev: 'realtimePush.ok',
        convs: convCount,
        msgs: msgCount,
      }),
    }).catch(() => {});
    // Tell the InboxPro tab(s) to re-render the affected threads. Content
    // scripts can't reach other tabs directly — route via the background.
    for (const convUrn of msgsByConv.keys()) {
      chrome.runtime.sendMessage({
        action: 'broadcastThreadUpdated',
        urn: convUrn,
        count: (msgsByConv.get(convUrn)?.size) || 0,
      }).catch(() => {});
    }
  } catch (e) {
    fetch('http://localhost:3030/api/sync-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        src: 'content',
        ev: 'realtimePush.fail',
        reason: e?.message || 'fetch threw',
      }),
    }).catch(() => {});
  }
}

// ── DOM scrolling ──────────────────────────────────────────────────────────────
function findScrollContainer() {
  const sels = [
    '.msg-conversations-container__conversations-list',
    '.scaffold-finite-scroll__content',
    'ul[class*="conversations-list"]',
    '.msg-conversations-container__pillar',
  ];
  for (const sel of sels) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      if (el.scrollHeight > el.clientHeight + 10) return el;
    }
  }
  return null;
}

async function scrollToLoadAll(onProgress) {
  let prevCount = 0;
  let stableRounds = 0;
  // Incremental mode: stop earlier — once we've seen mostly known convs we're done
  const maxRounds = incrementalMode ? 15 : 300;
  const maxStable = incrementalMode ? 3 : 12;
  const baseDelay = 1200;

  for (let round = 0; round < maxRounds; round++) {
    // In incremental mode: if all currently captured convs are already known
    // (and unchanged), we can stop early
    if (incrementalMode && conversationsByUrn.size > 0) {
      const newOrChanged = [...conversationsByUrn.values()].filter((c) => {
        const knownTs = knownConversations[c.entityUrn];
        return !knownTs || (c.lastActivityAt && c.lastActivityAt > knownTs);
      });
      if (newOrChanged.length === 0 && round >= 3) {
        onProgress?.('No new activity — done.');
        break;
      }
    }

    const sc = findScrollContainer();
    if (sc) {
      // Multiple scroll techniques — some pagination triggers need wheel events
      sc.scrollTop = sc.scrollHeight;
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
      // Find last visible item, scroll it into view
      const items = sc.querySelectorAll('li');
      if (items.length > 0) {
        items[items.length - 1].scrollIntoView({ block: 'end', behavior: 'auto' });
      }
    }

    // Wait — back off after each stable round to give slow pages more time
    const waitMs = baseDelay + stableRounds * 300;
    await sleep(waitMs);

    const count = conversationsByUrn.size;
    onProgress?.(`Loading inbox… ${count} conversations (round ${round + 1})`);

    if (count === prevCount) {
      stableRounds++;
      if (stableRounds >= maxStable) break;
    } else {
      stableRounds = 0;
      prevCount = count;
    }
  }
}

// Force LinkedIn to re-fetch the initial conversation list by clicking another
// category and clicking back to "All". This makes it issue a fresh API call
// that our hook can capture (necessary because the FIRST page-load fetch
// happens before our hook is installed on already-open tabs).
async function forceInboxRefresh(onProgress) {
  const tabSelectors = [
    'button[aria-label*="Focused"], button[role="tab"]',
    'a[class*="pill"], button[class*="filter"]',
  ];
  let allTabs = [];
  for (const sel of tabSelectors) {
    allTabs = allTabs.concat([...document.querySelectorAll(sel)]);
  }
  const firstTabText = (t) => (t.textContent || '').trim().toLowerCase();

  // Find candidate tabs to toggle
  const focusedTab = allTabs.find((t) => firstTabText(t) === 'focused');
  const otherTab = allTabs.find((t) => firstTabText(t) === 'other');
  const allTab = allTabs.find((t) => ['all', 'all messages'].includes(firstTabText(t)));

  // Click "Other" (or any non-focused tab), wait, then click back to "Focused"/"All"
  if (otherTab) {
    otherTab.click();
    await sleep(1500);
  }
  if (focusedTab) {
    focusedTab.click();
    await sleep(1500);
  } else if (allTab) {
    allTab.click();
    await sleep(1500);
  }
  onProgress?.(`Refresh complete · ${conversationsByUrn.size} captured so far`);
}

// Try clicking inbox category tabs to capture conversations from "Other" / "InMail" etc.
async function visitAllInboxTabs(onProgress) {
  const tabs = [...document.querySelectorAll('[role="tab"], button[class*="filter"], a[class*="pill"]')];
  const messagingTabs = tabs.filter((t) => {
    const txt = (t.textContent || '').trim().toLowerCase();
    return ['focused', 'other', 'inmail', 'archived', 'unread', 'my connections', 'all'].includes(txt);
  });
  for (const tab of messagingTabs) {
    try {
      onProgress?.(`Switching to "${(tab.textContent || '').trim()}" tab…`);
      tab.click();
      await sleep(1500);
      await scrollToLoadAll(onProgress);
    } catch (e) {}
  }
}

// ── Phase 2: bulk-fetch messages for every conversation ───────────────────────
// URL-encode a LinkedIn URN like LinkedIn does (encode parens too)
function encodeURN(urn) {
  return encodeURIComponent(urn)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/'/g, '%27')
    .replace(/!/g, '%21');
}

// Generate alternate URN formats — LinkedIn uses different namespaces in different APIs
function urnVariants(entityUrn) {
  if (!entityUrn) return [];
  const variants = new Set([entityUrn]);
  const inner = entityUrn.match(/\(([^)]+)\)/)?.[1];
  if (inner) {
    variants.add(`urn:li:msg_conversation:(${inner})`);
    variants.add(`urn:li:fsd_messagingConversation:(${inner})`);
    variants.add(`urn:li:messagingThread:(${inner})`);
  }
  return [...variants];
}

// Known queryId for messengerMessages (used as fallback when not captured live)
const KNOWN_MESSAGES_QUERY_ID = 'messengerMessages.5846eeb71c981f11e0134cb6626cc314';

function buildMessagesUrl(conversationUrn) {
  const encUrn = encodeURN(conversationUrn);
  return `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${KNOWN_MESSAGES_QUERY_ID}&variables=(conversationUrn:${encUrn},count:50)`;
}

async function fetchMessagesForAll(onProgress) {
  let convs = [...conversationsByUrn.values()];
  if (convs.length === 0) return;

  // Incremental mode: only fetch messages for new or updated conversations
  if (incrementalMode) {
    const before = convs.length;
    convs = convs.filter((c) => {
      const knownTs = knownConversations[c.entityUrn];
      // Fetch if conversation is new OR has newer activity than what app has
      return !knownTs || (c.lastActivityAt && c.lastActivityAt > knownTs);
    });
    onProgress?.(`Incremental: fetching messages for ${convs.length}/${before} (changed/new only)`);
    if (convs.length === 0) return;
  }

  // Try to capture a live URL pattern by clicking — but proceed with hardcoded fallback either way
  if (messageURLPatterns.length === 0) {
    onProgress?.('Capturing message URL pattern…');
    for (let i = 0; i < 3; i++) {
      const items = document.querySelectorAll(
        'li.msg-conversation-listitem a, ul[class*="conversations-list"] li a',
      );
      if (items[i]) {
        items[i].click();
        await sleep(2000);
        if (messageURLPatterns.length > 0) break;
      }
    }
  }

  const liveTemplate = messageURLPatterns[0];
  onProgress?.(liveTemplate
    ? 'Using live captured URL pattern'
    : 'Using known queryId fallback');
  const csrf = document.cookie.match(/JSESSIONID=["']?(ajax:[^;"'\s]+)/)?.[1] || '';
  const headers = {
    'csrf-token': csrf,
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
  };

  let done = 0;
  let success = 0;
  const total = convs.length;
  const concurrency = 4;
  const queue = [...convs];

  async function worker() {
    while (queue.length > 0) {
      const conv = queue.shift();
      if (!conv) break;
      const urn = conv.entityUrn;
      if (urn) {
        // Build candidate URLs: live template substitution + hardcoded fallback
        const variants = urnVariants(urn);
        const urls = [];
        for (const variant of variants) {
          if (liveTemplate) {
            urls.push(
              liveTemplate
                .replace(/conversationUrn:[^,)]+/, 'conversationUrn:' + encodeURN(variant))
                .replace(/\bcount:\d+/, 'count:50'),
            );
          }
          urls.push(buildMessagesUrl(variant));
        }
        for (const url of urls) {
          try {
            const r = await fetch(url, { headers });
            if (!r.ok) continue;
            const text = await r.text();
            const sizeBefore = countMessages();
            try { walkAndHarvest(JSON.parse(text), url); } catch {}
            if (countMessages() > sizeBefore) {
              success++;
              break;
            }
          } catch (e) {}
        }
      }
      done++;
      if (done % 5 === 0 || done === total) {
        onProgress?.(`Fetching messages: ${done}/${total} (${success} hit) · ${countMessages()} msgs`);
      }
      await sleep(120);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  onProgress?.(`Done: ${success}/${total} convs got messages, ${countMessages()} total messages`);
}

// ── Fetch existing state from app for incremental sync ────────────────────────
async function fetchAppState() {
  try {
    const r = await fetch('http://localhost:3030/api/state');
    if (!r.ok) return null;
    const j = await r.json();
    return j;
  } catch (e) {
    return null;
  }
}

// In incremental mode, this is the existing conversation state we have
let knownConversations = {}; // entityUrn → lastActivityAt(ms)
let incrementalMode = false;

// ── Top-level sync ─────────────────────────────────────────────────────────────
async function runSync(onProgress) {
  if (!location.pathname.includes('/messaging')) {
    return { error: 'Open https://www.linkedin.com/messaging in this tab first.' };
  }
  await injectScript();
  await sleep(500);

  // Reset state
  conversationsByUrn.clear();
  messagesByConvKey.clear();
  entitiesByUrn.clear();
  myProfileUrn = '';

  // Check what the app already has
  const appState = await fetchAppState();
  knownConversations = appState?.conversationsByUrn || {};
  const knownCount = Object.keys(knownConversations).length;
  incrementalMode = knownCount > 0;
  if (incrementalMode) {
    onProgress?.(`Incremental sync — app has ${knownCount} conversations cached`);
  } else {
    onProgress?.('Full sync — no cached state');
  }

  // Click the first conversation early so we capture a message URL pattern
  const firstItem = document.querySelector('li.msg-conversation-listitem a, [class*="conversation-listitem"] a');
  if (firstItem) {
    firstItem.click();
    await sleep(2000);
  }

  // Force a re-fetch of the initial inbox by toggling tabs/categories
  // (catches conversations LinkedIn fetched before our hook was active)
  onProgress?.('Refreshing initial inbox…');
  await forceInboxRefresh(onProgress);

  // Phase 1: scroll the main inbox + visit other tabs
  const sc = findScrollContainer();
  if (sc) sc.scrollTop = 0;
  await sleep(300);
  await scrollToLoadAll(onProgress);
  await visitAllInboxTabs(onProgress);

  // Phase 2: bulk-fetch messages for everything
  await fetchMessagesForAll(onProgress);

  // Build the response
  const conversations = [...conversationsByUrn.values()];

  // Pack messages keyed by the conversation's entityUrn (= conv.id in the app)
  const messagesPayload = {};
  for (const conv of conversations) {
    const innerKey = convKeyFromUrn(conv.entityUrn);
    // Try every variant — message keys vary across API responses
    let msgs =
      messagesByConvKey.get(innerKey) ??
      messagesByConvKey.get(conv.entityUrn) ?? [];

    // Also try matching by the inner key as a substring of stored keys
    if (msgs.length === 0 && innerKey) {
      for (const [k, v] of messagesByConvKey) {
        if (k.includes(innerKey) || innerKey.includes(k)) {
          msgs = v;
          break;
        }
      }
    }

    if (msgs.length > 0) {
      messagesPayload[conv.entityUrn] = msgs;
    }
  }
  console.log(`[InboxPro] Packed messages for ${Object.keys(messagesPayload).length}/${conversations.length} conversations`);

  // Treat everything we just packed as "known in DB" for notification gating —
  // after a full sync, the app will have all these convs and we should
  // notify on subsequent new messages to them.
  for (const c of conversations) if (c.entityUrn) knownConvUrnsAtStart.add(c.entityUrn);
  knownConvsLoaded = true;
  ensureAutoSyncStarted();

  // Pack the entity dictionary so the app can resolve URN references in conversations
  const entitiesPayload = {};
  for (const [urn, e] of entitiesByUrn) {
    if (isProfile(e) || urn.includes('fsd_profile') || urn.includes('miniProfile')) {
      entitiesPayload[urn] = e;
    }
  }

  return {
    conversations,
    messages: messagesPayload,
    entities: entitiesPayload,
    myProfileUrn,
    count: conversations.length,
    messageCount: countMessages(),
    debugLog: `${conversations.length} convs, ${countMessages()} msgs, ${Object.keys(entitiesPayload).length} profile entities`,
  };
}

async function dumpSample() {
  await injectScript();
  await sleep(500);

  // Click first conversation to make sure messages get fetched
  const firstItem = document.querySelector('li.msg-conversation-listitem a, [class*="conversation-listitem"] a');
  if (firstItem) {
    firstItem.click();
    await sleep(2500);
  }

  const sampleConv = [...conversationsByUrn.values()].slice(0, 2);
  const sampleMsgs = [...messagesByConvKey.entries()].slice(0, 2).map(([k, v]) => ({
    convKey: k,
    sampleMessages: v.slice(0, 2),
  }));
  const profileEntities = [];
  let count = 0;
  for (const [urn, e] of entitiesByUrn) {
    if (urn.includes('fsd_profile') || urn.includes('miniProfile')) {
      profileEntities.push({ urn, sample: e });
      if (++count >= 2) break;
    }
  }

  return {
    myProfileUrn,
    totalConvs: conversationsByUrn.size,
    totalMessages: countMessages(),
    totalEntities: entitiesByUrn.size,
    sampleConvKeys: sampleConv.map((c) => ({
      entityUrn: c.entityUrn,
      $type: c.$type,
      topLevelKeys: Object.keys(c),
      title: c.title,
      conversationParticipants: c.conversationParticipants?.slice(0, 2),
      starParticipants: c['*conversationParticipants']?.slice(0, 2),
    })),
    fullSampleConv: sampleConv[0],
    sampleMsgs,
    sampleProfiles: profileEntities,
  };
}

// ── Passive auto-sync ──────────────────────────────────────────────────────────
// Every AUTO_SYNC_INTERVAL_MS, if we've harvested anything new since the last
// push, send ONLY the delta to the app. This keeps InboxPro fresh while the
// user is just browsing LinkedIn normally.

function ensureAutoSyncStarted() {
  // The 10-second poll in bridge.js (running on the InboxPro tab) is now the
  // canonical sync path. This function only loads "known conv URNs" once so
  // notifications fire correctly. The old 15s push-only-deltas interval was
  // removed in favor of the bridge poll.
  if (autoSyncStarted) return;
  autoSyncStarted = true;
  loadKnownConvUrns();
}

async function loadKnownConvUrns() {
  try {
    const r = await fetch(`${INBOXPRO_URL}/api/state`);
    if (!r.ok) { knownConvsLoaded = true; return; }
    const j = await r.json();
    const map = j?.conversationsByUrn || {};
    for (const urn of Object.keys(map)) knownConvUrnsAtStart.add(urn);
  } catch (e) {
    // Can't reach app — that's fine, notifications will just be conservative
  } finally {
    knownConvsLoaded = true;
  }
}

// ── Desktop notifications for new inbound messages ────────────────────────────
function extractSenderUrn(m) {
  return (
    m?.sender?.hostIdentityUrn ||
    m?.sender?.entityUrn ||
    m?.from?.hostIdentityUrn ||
    m?.['*sender'] ||
    ''
  );
}

function extractSenderName(m) {
  const s = m?.sender || m?.from || {};
  const first = s?.firstName?.text || s?.firstName || '';
  const last = s?.lastName?.text || s?.lastName || '';
  const name = [first, last].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (s?.name?.text) return s.name.text;
  if (typeof s?.name === 'string') return s.name;
  return 'New LinkedIn message';
}

function extractMessagePreview(m) {
  const body = m?.body;
  if (typeof body === 'string') return body;
  if (typeof body?.text === 'string') return body.text;
  if (typeof m?.subject === 'string') return m.subject;
  return '';
}

function maybeNotifyFromNewMessages(newMsgEntries) {
  if (!knownConvsLoaded) return; // Wait until we know which convs are in the DB
  const now = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;

  for (const { msg, convUrn } of newMsgEntries) {
    if (!msg?.entityUrn || notifiedMsgUrns.has(msg.entityUrn)) continue;
    // Only notify for "real" deliveries within the last 5 minutes.
    const deliveredAt = typeof msg.deliveredAt === 'number' ? msg.deliveredAt : 0;
    if (!deliveredAt || now - deliveredAt > FIVE_MIN) continue;
    // Only for inbound messages (NOT from me). If we don't know who "me" is,
    // skip rather than risk notifying for our own sends.
    const senderUrn = extractSenderUrn(msg);
    if (!myProfileUrn) continue;
    if (senderUrn && senderUrn === myProfileUrn) continue;
    // Only for conversations that already exist in the app's DB. This avoids
    // spamming during the initial harvest when everything looks "new".
    if (!convUrn || !knownConvUrnsAtStart.has(convUrn)) continue;

    notifiedMsgUrns.add(msg.entityUrn);
    scheduleNotification(convUrn, msg);
  }
}

function scheduleNotification(convUrn, msg) {
  // Burst-throttle: if >3 messages arrive within 10s for the same conv,
  // collapse them into a single grouped notification.
  const now = Date.now();
  const window10s = 10_000;
  const stamps = (recentNotifyByConv.get(convUrn) || []).filter((t) => now - t < window10s);
  stamps.push(now);
  recentNotifyByConv.set(convUrn, stamps);

  const name = extractSenderName(msg);
  const previewRaw = extractMessagePreview(msg) || '';
  const preview = previewRaw.slice(0, 100);

  if (stamps.length > 3) {
    // Bucket into a 10s-delayed grouped notification per conversation.
    let pending = pendingGroupByConv.get(convUrn);
    if (!pending) {
      pending = { count: 0, lastMsg: msg, senderName: name, timer: null };
      pendingGroupByConv.set(convUrn, pending);
    }
    pending.count++;
    pending.lastMsg = msg;
    pending.senderName = name;
    if (!pending.timer) {
      pending.timer = setTimeout(() => {
        const p = pendingGroupByConv.get(convUrn);
        if (!p) return;
        pendingGroupByConv.delete(convUrn);
        const title = `${p.senderName} (${p.count} new messages)`;
        const body = (extractMessagePreview(p.lastMsg) || '').slice(0, 100);
        chrome.runtime.sendMessage({
          action: 'notify',
          title,
          body,
          convId: convUrn,
        }).catch(() => {});
      }, 2_000);
    }
    return;
  }

  chrome.runtime.sendMessage({
    action: 'notify',
    title: name,
    body: preview,
    convId: convUrn,
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'sync') {
    runSync((msg) =>
      chrome.runtime.sendMessage({ action: 'progress', message: msg }).catch(() => {}),
    )
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message, stack: e.stack }));
    return true;
  }
  if (message.action === 'dumpSample') {
    dumpSample()
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message, stack: e.stack }));
    return true;
  }
});
