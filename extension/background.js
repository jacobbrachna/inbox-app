const INBOXPRO_URL = 'http://localhost:3030';

// Broadcast a message to all open InboxPro tabs.
async function broadcastToInboxPro(message) {
  try {
    const tabs = await chrome.tabs.query({ url: `${INBOXPRO_URL}/*` });
    for (const t of tabs) {
      if (t.id != null) chrome.tabs.sendMessage(t.id, message).catch(() => {});
    }
  } catch (e) {}
}

// Fire-and-forget diagnostic log to the app — lets me see what's happening
// across the extension without console scraping.
function syncLog(ev, data) {
  fetch(`${INBOXPRO_URL}/api/sync-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ src: 'background', ev, ...(data || {}) }),
  }).catch(() => {});
}

async function pushToApp(payload) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (e) {
    const reason = `JSON.stringify failed: ${e?.message || 'unknown'}`;
    console.error('[InboxPro] push failed:', reason);
    syncLog('pushToApp.fail', { reason, payloadKeys: Object.keys(payload || {}) });
    return { ok: false, reason };
  }
  const sizeMB = (body.length / 1024 / 1024).toFixed(2);
  syncLog('pushToApp.start', {
    convs: Array.isArray(payload?.conversations) ? payload.conversations.length : 0,
    msgsKeys: Object.keys(payload?.messages || {}).length,
    sizeMB,
  });
  try {
    const r = await fetch(`${INBOXPRO_URL}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const text = await r.text().catch(() => '');
    if (!r.ok) {
      const reason = `HTTP ${r.status}: ${text.slice(0, 300)}`;
      console.error('[InboxPro] push failed:', reason);
      syncLog('pushToApp.fail', { reason, status: r.status });
      return { ok: false, reason, status: r.status };
    }
    syncLog('pushToApp.ok', { sizeMB, response: text.slice(0, 200) });
    return { ok: true };
  } catch (e) {
    const reason = `fetch threw: ${e?.message || 'unknown'}`;
    console.error('[InboxPro] push failed:', reason);
    syncLog('pushToApp.fail', { reason });
    return { ok: false, reason };
  }
}

async function openApp() {
  const tabs = await chrome.tabs.query({ url: `${INBOXPRO_URL}/*` });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { url: `${INBOXPRO_URL}/?synced=1`, active: true });
  } else {
    await chrome.tabs.create({ url: `${INBOXPRO_URL}/?synced=1` });
  }
}

// ── Notifications ────────────────────────────────────────────────────────────
// Map of chrome notification id → conversation entityUrn for click handling.
const notificationToConv = new Map();

async function showNotification({ title, body, convId }) {
  try {
    const notifId = await new Promise((resolve) => {
      chrome.notifications.create(
        '',
        {
          type: 'basic',
          iconUrl: 'https://www.linkedin.com/favicon.ico',
          title: title || 'New LinkedIn message',
          message: body || '',
          priority: 1,
        },
        (id) => resolve(id),
      );
    });
    if (notifId && convId) {
      notificationToConv.set(notifId, convId);
      // Auto-evict to bound memory — Chrome's notifications can live for a while
      // but we don't need to track them forever.
      setTimeout(() => notificationToConv.delete(notifId), 10 * 60 * 1000);
    }
  } catch (e) {
    console.error('[InboxPro] notify failed:', e);
  }
}

chrome.notifications.onClicked.addListener((notifId) => {
  const convId = notificationToConv.get(notifId);
  if (!convId) return;
  const url = `${INBOXPRO_URL}/?conv=${encodeURIComponent(convId)}`;
  (async () => {
    const tabs = await chrome.tabs.query({ url: `${INBOXPRO_URL}/*` });
    if (tabs.length > 0) {
      await chrome.tabs.update(tabs[0].id, { url, active: true });
      try { await chrome.windows.update(tabs[0].windowId, { focused: true }); } catch (e) {}
    } else {
      await chrome.tabs.create({ url });
    }
    chrome.notifications.clear(notifId);
    notificationToConv.delete(notifId);
  })();
});

// ── Background sync: fetch directly from LinkedIn using user cookies ─────────
// This runs from the service worker context, so it works even when the user has
// no LinkedIn tab open. Triggered by chrome.alarms every 5 min, or on-demand
// via the bridge content script on localhost:3030 (Refresh button in InboxPro).

const MESSAGES_QUERY_ID = 'messengerMessages.5846eeb71c981f11e0134cb6626cc314';
const CONVERSATIONS_QUERY_ID = 'messengerConversations.9501074288a12f3ae9e3c7ea243bccbf';

function encodeURN(urn) {
  return encodeURIComponent(urn)
    .replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/'/g, '%27').replace(/!/g, '%21');
}

// ── Send a message via LinkedIn's API ────────────────────────────────────────
// LinkedIn's createMessage endpoint pattern (post-2024 GraphQL):
//   POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
//   Body: { message: { body: {text: "..."}, conversationUrn: "urn:..."},
//           dedupeByClientGeneratedToken: "<uuid>" }
async function sendLinkedInMessage({ conversationUrn, body }) {
  const auth = await getLinkedInAuth();
  if (!auth) return { ok: false, reason: 'not-logged-in' };

  // Need mailboxUrn (= my profile URN) — pull from the app's AppState
  let mailboxUrn = '';
  try {
    const sr = await fetch(`${INBOXPRO_URL}/api/state`);
    if (sr.ok) mailboxUrn = (await sr.json()).myProfileUrn || '';
  } catch {}
  if (!mailboxUrn) return { ok: false, reason: 'no mailboxUrn — run a full sync first' };

  const headers = { ...liHeaders(auth.csrf), 'content-type': 'application/json; charset=UTF-8' };

  const originToken = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Payload format captured from LinkedIn's own UI.
  const payload = {
    message: {
      body: { attributes: [], text: body },
      renderContentUnions: [],
      conversationUrn,
      originToken,
    },
    mailboxUrn,
    trackingId: originToken.slice(0, 16),
    dedupeByClientGeneratedToken: false,
  };

  const url = 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage';

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    const responseText = await r.text().catch(() => '');
    if (!r.ok) {
      return {
        ok: false,
        reason: `LinkedIn returned HTTP ${r.status}`,
        status: r.status,
        debugBody: responseText.slice(0, 500),
      };
    }
    return { ok: true, status: r.status, response: responseText.slice(0, 200) };
  } catch (e) {
    return { ok: false, reason: e?.message || 'send threw' };
  }
}

// ── LinkedIn typing indicator ─────────────────────────────────────────────────
// Fire-and-forget POST per typing burst. LinkedIn shows the indicator on the
// recipient side for ~5s after each request, so the UI debounces a fire every
// ~3s while you're typing.
async function sendLinkedInTyping({ conversationUrn }) {
  const auth = await getLinkedInAuth();
  if (!auth) return { ok: false, reason: 'not-logged-in' };
  if (!conversationUrn) return { ok: false, reason: 'conversationUrn required' };
  const url = 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerConversations?action=typing';
  const headers = { ...liHeaders(auth.csrf), 'content-type': 'application/json; charset=UTF-8' };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ conversationUrn }),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, reason: e?.message || 'typing fetch threw' };
  }
}

// ── Debug probe: dump 3 real LinkedIn API responses to disk ────────────────
// Same approach we used for SN. Captures pages 1-3 of PRIMARY_INBOX so we
// can study the actual response shape + pagination behavior locally before
// writing parser/pagination code.
async function debugLinkedInApi() {
  const auth = await getLinkedInAuth();
  if (!auth) return { ok: false, reason: 'not-logged-in' };

  let myProfileUrn = '';
  try {
    const sr = await fetch(`${INBOXPRO_URL}/api/state`);
    if (sr.ok) myProfileUrn = (await sr.json()).myProfileUrn || '';
  } catch {}
  if (!myProfileUrn) return { ok: false, reason: 'no-myProfileUrn — run regular sync once first' };

  const headers = liHeaders(auth.csrf);
  const category = 'PRIMARY_INBOX';
  const dumps = [];

  // Page 1: start from now()
  // Page 2: use oldest lastActivityAt as cursor
  // Page 3: same logic
  let cursor = Date.now() + 60_000;

  for (let pageNum = 1; pageNum <= 3; pageNum++) {
    const convVars = `(query:(predicateUnions:List((conversationCategoryPredicate:(category:${category})))),count:20,mailboxUrn:${encodeURN(myProfileUrn)},lastUpdatedBefore:${cursor})`;
    const url = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${CONVERSATIONS_QUERY_ID}&variables=${convVars}`;

    try {
      const r = await fetch(url, { headers, credentials: 'include' });
      if (!r.ok) {
        dumps.push({ page: pageNum, status: r.status, ok: false });
        break;
      }
      const body = await r.text();
      // Ship to localhost for disk dump
      await fetch(`${INBOXPRO_URL}/api/import/li-debug-capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: `${category}-page${pageNum}-cursor${cursor}`, body }),
      });
      dumps.push({ page: pageNum, status: r.status, ok: true, bytes: body.length, cursor });

      // Parse and find oldest lastActivityAt for next page cursor — using the
      // SAME tree-walk approach as harvestPayload, since that's what was
      // working for at least SOME pagination earlier.
      const json = JSON.parse(body);
      let oldest = cursor;
      const stack = [json];
      const visited = new WeakSet();
      while (stack.length) {
        const v = stack.pop();
        if (!v || typeof v !== 'object') continue;
        if (visited.has(v)) continue;
        visited.add(v);
        if (typeof v.lastActivityAt === 'number' && v.lastActivityAt < oldest) {
          oldest = v.lastActivityAt;
        }
        if (Array.isArray(v)) { for (const x of v) stack.push(x); continue; }
        for (const val of Object.values(v)) if (val && typeof val === 'object') stack.push(val);
      }
      if (oldest === cursor) {
        dumps[dumps.length - 1].cursorStalled = true;
        break;
      }
      cursor = oldest;
    } catch (e) {
      dumps.push({ page: pageNum, ok: false, err: String(e).slice(0, 100) });
      break;
    }
  }

  syncLog('liApiDebug.done', { dumps });
  return { ok: true, dumps };
}

// ── Experimental: API-driven LinkedIn initial sync ──────────────────────────
// Paginates every category via lastUpdatedBefore cursor, optionally fetches
// full message history per conv. Mirrors the SN sync architecture. Purely
// additive — every push goes through /api/import which upserts. Existing
// scroll-sync still works and can be used to repair if anything looks off.
// Extract primary conv entities from a LinkedIn voyager response.
//
// LinkedIn uses normalized JSON: the query result has `*elements` (asterisk
// indicates references) which is an array of URN strings, and those URNs are
// resolved against `included` (fully-hydrated entities).
//
// Returns { convs, nextCursor }:
//   - convs: the resolved Conversation entities (in order)
//   - nextCursor: the metadata.nextCursor value LinkedIn provided for next page
function extractPrimaryFromLiResponse(json) {
  const result = { convs: [], nextCursor: null };
  const q = json?.data?.data?.messengerConversationsByCategoryQuery;
  if (!q || typeof q !== 'object') return result;

  // metadata.nextCursor — LinkedIn's own pagination cursor
  if (q.metadata && typeof q.metadata.nextCursor === 'string') {
    result.nextCursor = q.metadata.nextCursor;
  } else if (q.metadata && typeof q.metadata.nextCursor === 'number') {
    result.nextCursor = String(q.metadata.nextCursor);
  }

  const urnRefs = q['*elements'];
  if (!Array.isArray(urnRefs) || urnRefs.length === 0) return result;

  // Build URN → entity lookup from `included`
  const byUrn = new Map();
  if (Array.isArray(json.included)) {
    for (const e of json.included) {
      if (e && typeof e.entityUrn === 'string') byUrn.set(e.entityUrn, e);
    }
  }

  // Resolve each URN ref to its full conv entity, preserving order
  for (const urn of urnRefs) {
    if (typeof urn !== 'string') continue;
    const ent = byUrn.get(urn);
    if (ent) result.convs.push(ent);
  }
  return result;
}

async function linkedInInitialSyncApi({
  deepFetch = true,
  onProgress = () => {},
} = {}) {
  const auth = await getLinkedInAuth();
  if (!auth) return { ok: false, reason: 'not-logged-in' };

  // Need myProfileUrn for the mailboxUrn in the query
  let myProfileUrn = '';
  try {
    const sr = await fetch(`${INBOXPRO_URL}/api/state`);
    if (sr.ok) myProfileUrn = (await sr.json()).myProfileUrn || '';
  } catch {}
  if (!myProfileUrn) return { ok: false, reason: 'no-myProfileUrn — run regular sync once first' };

  const headers = liHeaders(auth.csrf);
  // INBOX = PRIMARY_INBOX + OTHER + ARCHIVE. Some accounts have an empty OTHER —
  // log it but don't fail. If the GraphQL query rejects a category, we skip it.
  const CATEGORIES = ['PRIMARY_INBOX', 'OTHER', 'ARCHIVE'];
  const PAGE_SIZE = 20;

  const totals = { pages: 0, convs: 0, msgs: 0, errors: 0, perCategory: {} };
  const allConvUrns = new Set();
  // Track which sample bodies to dump for diagnosis (first page of each category)
  const dumpedFirstPage = new Set();

  // ── Phase 1: paginate each category using LinkedIn's nextCursor ──
  // Page 1: lastUpdatedBefore:<now> (matches existing scroll-sync)
  // Page 2+: nextCursor:<metadata.nextCursor from previous response>
  // Stop when metadata.nextCursor is empty/null. This is the EXACT pagination
  // pattern LinkedIn's own UI uses — verified by inspecting captured calls.
  for (const category of CATEGORIES) {
    let nextCursor = null; // null means "first page — use lastUpdatedBefore"
    const initialTs = String(Date.now() + 60_000);
    let safety = 200;
    totals.perCategory[category] = 0;

    while (safety-- > 0) {
      // Build cursor var. Page 1: lastUpdatedBefore. Page 2+: nextCursor.
      const cursorVar = nextCursor === null
        ? `lastUpdatedBefore:${initialTs}`
        : `nextCursor:${encodeURIComponent(nextCursor)}`;
      const convVars = `(query:(predicateUnions:List((conversationCategoryPredicate:(category:${category})))),count:${PAGE_SIZE},mailboxUrn:${encodeURN(myProfileUrn)},${cursorVar})`;
      const url = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${CONVERSATIONS_QUERY_ID}&variables=${convVars}`;

      let json;
      try {
        const r = await fetch(url, { headers, credentials: 'include' });
        if (!r.ok) {
          syncLog('liApiSync.fetchFail', { category, status: r.status });
          totals.errors++;
          break;
        }
        json = await r.json();
      } catch (e) {
        syncLog('liApiSync.fetchErr', { category, err: e?.message });
        totals.errors++;
        break;
      }

      // GraphQL error envelope. CAN coexist with valid data — a single field
      // (e.g. draftMessages on one conv) can fail while the rest of the page
      // is intact. Only bail if the actual query result is missing.
      const innerErrors = json?.data?.errors || json?.errors;
      const queryResult = json?.data?.data?.messengerConversationsByCategoryQuery;
      const hasData = queryResult && Array.isArray(queryResult['*elements']) && queryResult['*elements'].length > 0;
      if (Array.isArray(innerErrors) && innerErrors.length > 0) {
        syncLog('liApiSync.partialError', {
          category, sample: JSON.stringify(innerErrors[0]).slice(0, 200),
          hasData, partialCount: hasData ? queryResult['*elements'].length : 0,
        });
        if (!hasData) {
          // Truly empty result + error — OTHER for accounts without it, or hard fail
          if (category !== 'OTHER') totals.errors++;
          break;
        }
        // Otherwise fall through and use the data we have
      }

      // Pull primary convs + the API's own pagination cursor
      const { convs: primaryConvs, nextCursor: apiCursor } = extractPrimaryFromLiResponse(json);

      // First-page diagnostic
      if (!dumpedFirstPage.has(category)) {
        dumpedFirstPage.add(category);
        syncLog('liApiSync.firstPage', {
          category,
          primary: primaryConvs.length,
          hasNextCursor: !!apiCursor,
          includedLen: Array.isArray(json?.included) ? json.included.length : 0,
        });
      }

      if (primaryConvs.length === 0) {
        syncLog('liApiSync.emptyPage', { category, pages: totals.perCategory[category] });
        break;
      }

      const newOnPage = primaryConvs.filter((c) => c.entityUrn && !allConvUrns.has(c.entityUrn)).length;

      // Harvest everything for /api/import. Server upserts.
      const { conversations, messages, entities } = harvestPayload(json);
      const messagesByConv = {};
      for (const m of messages) {
        const convUrn = m.conversation?.entityUrn || m.conversationUrn || m['*conversation'] || '';
        if (!convUrn) continue;
        (messagesByConv[convUrn] ||= []).push(m);
      }
      const tagged = conversations.map((c) => ({ ...c, _sourceCategory: category }));
      await pushToApp({ conversations: tagged, messages: messagesByConv, entities, myProfileUrn });
      primaryConvs.forEach((c) => { if (c.entityUrn) allConvUrns.add(c.entityUrn); });

      totals.pages++;
      totals.perCategory[category] += newOnPage;
      totals.convs = allConvUrns.size;
      onProgress({
        phase: 'inbox',
        category,
        pages: totals.pages,
        convs: totals.convs,
      });

      // Advance via LinkedIn's own cursor. Done when metadata.nextCursor is
      // absent/empty (LinkedIn's signal for end-of-results).
      if (!apiCursor) {
        syncLog('liApiSync.endOfResults', { category, pages: totals.perCategory[category] });
        break;
      }
      // Stall guard: if cursor doesn't change AND we got nothing new, bail.
      if (apiCursor === nextCursor && newOnPage === 0) {
        syncLog('liApiSync.cursorRepeat', { category });
        break;
      }
      nextCursor = apiCursor;

      await new Promise((res) => setTimeout(res, 200));
    }
  }

  // ── Phase 2: deep-fetch messages per conv (full history) ──
  if (deepFetch && allConvUrns.size > 0) {
    const urns = Array.from(allConvUrns);
    onProgress({ phase: 'messages', total: urns.length, done: 0 });

    // Concurrency 2, like SN deep-fetch. 150ms gap between batches.
    let idx = 0;
    async function worker() {
      while (idx < urns.length) {
        const my = idx++;
        const urn = urns[my];
        const msgUrl = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${MESSAGES_QUERY_ID}&variables=(conversationUrn:${encodeURN(urn)},count:50)`;
        try {
          const r = await fetch(msgUrl, { headers, credentials: 'include' });
          if (r.ok) {
            const j = await r.json();
            const harvested = harvestPayload(j);
            if (harvested.messages.length > 0) {
              await pushToApp({
                conversations: [],
                messages: { [urn]: harvested.messages },
                entities: harvested.entities,
                myProfileUrn,
              });
              totals.msgs += harvested.messages.length;
            }
          } else {
            totals.errors++;
          }
        } catch { totals.errors++; }
        if (my % 5 === 0) {
          onProgress({ phase: 'messages', total: urns.length, done: totals.msgs, fetched: my + 1 });
        }
        await new Promise((res) => setTimeout(res, 150));
      }
    }
    await Promise.all([worker(), worker()]);
  }

  syncLog('liApiSync.done', totals);
  return { ok: true, ...totals };
}

// ── Send a Sales Navigator message ───────────────────────────────────────────
// Payload format captured from SN's own UI (POST salesApiMessageActions):
//   { createMessageRequest: { body, trackingId, copyToCrm, threadId } }
// trackingId is 16 random bytes, encoded as a Latin-1 string (each char = 1 byte).
async function sendSnMessage({ threadId, body }) {
  const auth = await getLinkedInAuth();
  if (!auth) return { ok: false, reason: 'not-logged-in' };
  if (!threadId) return { ok: false, reason: 'threadId required' };
  if (typeof body !== 'string' || body.length === 0) return { ok: false, reason: 'body required' };

  // Strip "sn:" prefix if it's there — SN's API expects the raw 2-<base64> id
  const cleanThreadId = threadId.replace(/^sn:/, '');

  // 16 random bytes → Latin-1 string (each char code 0–255)
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let trackingId = '';
  for (let i = 0; i < bytes.length; i++) trackingId += String.fromCharCode(bytes[i]);

  const payload = {
    createMessageRequest: {
      body,
      trackingId,
      copyToCrm: false,
      threadId: cleanThreadId,
    },
  };

  const url = 'https://www.linkedin.com/sales-api/salesApiMessageActions?action=createMessage';
  const headers = {
    ...snHeaders(auth.csrf),
    'content-type': 'application/json; charset=UTF-8',
  };

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    const responseText = await r.text().catch(() => '');
    syncLog('sn.send.result', {
      ok: r.ok, status: r.status,
      threadId: cleanThreadId.slice(0, 30),
      bodyLen: body.length,
      response: responseText.slice(0, 200),
    });
    if (!r.ok) {
      return {
        ok: false,
        reason: `SN returned HTTP ${r.status}`,
        status: r.status,
        debugBody: responseText.slice(0, 500),
      };
    }
    // After send succeeds, kick off a refresh so the new message lands in DB
    snBackgroundSync().catch(() => {});
    return { ok: true, status: r.status, response: responseText.slice(0, 200) };
  } catch (e) {
    return { ok: false, reason: e?.message || 'send threw' };
  }
}

// ── Mirror local actions to Sales Navigator ──────────────────────────────────
// Patterns captured from real SN UI interactions:
//   POST /sales-api/salesApiMessagingThreads/<id>
//     body: {"patch":{"$set":{"archived":true|false}}}
//   POST /sales-api/salesApiMessagingThreads/<id>?action=markAsRead
//   POST /sales-api/salesApiMessagingThreads/<id>?action=markAsUnread
// Thread id in path uses URL-encoded "==" (i.e. %3D%3D) — matches SN UI behavior.
async function mirrorToSn({ kind, urn }) {
  const auth = await getLinkedInAuth();
  if (!auth) {
    syncLog('snMirror.fail', { kind, reason: 'not-logged-in' });
    return { ok: false, reason: 'not-logged-in' };
  }
  if (!urn) return { ok: false, reason: 'urn required' };

  const cleanThreadId = String(urn).replace(/^sn:/, '');
  // SN's own UI URL-encodes the "==" padding in the path. Match it.
  const encodedId = cleanThreadId.replace(/=/g, '%3D');
  const base = `https://www.linkedin.com/sales-api/salesApiMessagingThreads/${encodedId}`;
  const headers = {
    ...snHeaders(auth.csrf),
    'content-type': 'application/json; charset=UTF-8',
  };

  let url = base;
  let body = '';
  if (kind === 'archive' || kind === 'unarchive') {
    body = JSON.stringify({ patch: { $set: { archived: kind === 'archive' } } });
  } else if (kind === 'read' || kind === 'unread') {
    url = `${base}?action=${kind === 'read' ? 'markAsRead' : 'markAsUnread'}`;
    body = ''; // captured request had no body
  } else {
    return { ok: false, reason: `unknown SN mirror kind: ${kind}` };
  }

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: body || undefined,
    });
    const responseText = await r.text().catch(() => '');
    syncLog('snMirror.result', {
      kind, ok: r.ok, status: r.status,
      threadId: cleanThreadId.slice(0, 30),
      response: responseText.slice(0, 200),
    });
    if (!r.ok) {
      return { ok: false, reason: `SN returned HTTP ${r.status}`, status: r.status, debugBody: responseText.slice(0, 500) };
    }
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, reason: e?.message || 'mirror threw' };
  }
}

// ── Mirror local actions to LinkedIn ─────────────────────────────────────────
// Patterns captured from real LinkedIn UI interactions:
//   DELETE /voyager/api/voyagerMessagingDashMessengerConversations/<urn>
//   POST   /voyager/api/voyagerMessagingDashMessengerConversations?action=addCategory
//     body: {"conversationUrns":[urn],"category":"ARCHIVE"|"STARRED"|...}
//   POST   /voyager/api/voyagerMessagingDashMessengerConversations?action=removeCategory
//     body: same as addCategory
//   POST   /voyager/api/voyagerMessagingDashMessengerConversations?ids=List(<urn>)
//     body: {"entities":{<urn>:{"patch":{"$set":{"read":true|false}}}}}
async function mirrorToLinkedIn({ kind, urn, value }) {
  const auth = await getLinkedInAuth();
  if (!auth) {
    syncLog('mirror.fail', { kind, urn: urn?.slice(-30), reason: 'not-logged-in' });
    return { ok: false, reason: 'not-logged-in' };
  }

  const headers = { ...liHeaders(auth.csrf), 'content-type': 'application/json; charset=UTF-8' };

  const base = 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerConversations';

  const logResult = async (r, extra = {}) => {
    const body = r.ok ? '' : (await r.text().catch(() => '')).slice(0, 200);
    syncLog(r.ok ? 'mirror.ok' : 'mirror.fail', {
      kind,
      urn: urn?.slice(-30),
      status: r.status,
      ...(body ? { body } : {}),
      ...extra,
    });
  };

  try {
    if (kind === 'delete') {
      const url = `${base}/${encodeURN(urn)}`;
      const r = await fetch(url, { method: 'DELETE', headers, credentials: 'include' });
      await logResult(r);
      return { ok: r.ok, status: r.status };
    }

    if (kind === 'read' || kind === 'unread') {
      const url = `${base}?ids=List(${encodeURN(urn)})`;
      const body = JSON.stringify({
        entities: { [urn]: { patch: { $set: { read: kind === 'read' } } } },
      });
      const r = await fetch(url, { method: 'POST', headers, credentials: 'include', body });
      await logResult(r);
      return { ok: r.ok, status: r.status };
    }

    // category-based actions: archive, unarchive, star, unstar
    if (['archive', 'unarchive', 'star', 'unstar'].includes(kind)) {
      const isAdd = kind === 'archive' || kind === 'star';
      const category = (kind === 'star' || kind === 'unstar') ? 'STARRED' : 'ARCHIVE';
      const url = `${base}?action=${isAdd ? 'addCategory' : 'removeCategory'}`;
      const body = JSON.stringify({ conversationUrns: [urn], category });
      const r = await fetch(url, { method: 'POST', headers, credentials: 'include', body });
      await logResult(r, { category });
      return { ok: r.ok, status: r.status };
    }

    syncLog('mirror.fail', { kind, urn: urn?.slice(-30), reason: `unknown kind: ${kind}` });
    return { ok: false, reason: `unknown kind: ${kind}` };
  } catch (e) {
    syncLog('mirror.fail', { kind, urn: urn?.slice(-30), reason: e?.message || 'fetch threw' });
    return { ok: false, reason: e?.message || 'fetch threw' };
  }
}

// ── Profile enrichment ──────────────────────────────────────────────────────
// LinkedIn's /voyager/api/identity/profiles/<id>/profileView REST endpoint has
// been progressively locked down. The reliable path is the SAME one LinkedIn's
// own UI uses to render /in/<slug>: fetch the public profile HTML page and
// parse the JSON LinkedIn embeds in <code id="bpr-guid-..."> blocks.
//
// Every profile page returns ~30+ of these blocks, each a JSON payload with
// `data` + `included[]` arrays. The `included[]` array carries profile,
// position, education entities tagged by $type. We walk them and extract the
// fields we want.
async function enrichLinkedInProfile({ profileUrn, profileUrl }) {
  const auth = await getLinkedInAuth();
  if (!auth) return { ok: false, reason: 'not-logged-in' };

  let pageUrl = profileUrl;
  let extra = {};

  if (!pageUrl) {
    if (!profileUrn) return { ok: false, reason: 'no profile URL or URN' };
    // Try Voyager API endpoints that return publicIdentifier + basic fields.
    // We try in order; first 200 with parseable JSON wins.
    const memberIdMatch = profileUrn.match(/fsd_profile:([A-Za-z0-9_-]+)/) || profileUrn.match(/:([A-Za-z0-9_-]+)$/);
    const memberId = memberIdMatch ? memberIdMatch[1] : profileUrn;
    const headers = { ...liHeaders(auth.csrf) };

    const candidates = [
      // GraphQL-shaped Dash endpoint — most current
      `https://www.linkedin.com/voyager/api/voyagerIdentityDashProfiles?q=memberIdentity&memberIdentity=${encodeURIComponent(profileUrn)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-12`,
      // Older REST endpoint
      `https://www.linkedin.com/voyager/api/identity/profiles/${encodeURIComponent(memberId)}`,
      // Older profileView (rich)
      `https://www.linkedin.com/voyager/api/identity/profiles/${encodeURIComponent(memberId)}/profileView`,
    ];

    let lastStatus = 0;
    let lastBody = '';
    for (const url of candidates) {
      try {
        const r = await fetch(url, { headers, credentials: 'include' });
        lastStatus = r.status;
        if (!r.ok) {
          syncLog('enrich.apiAttempt', { status: r.status, url: url.slice(-80) });
          continue;
        }
        const json = await r.json();
        const result = extractFromVoyager(json);
        if (result.publicIdentifier) {
          pageUrl = `https://www.linkedin.com/in/${result.publicIdentifier}/`;
          extra = result;
          syncLog('enrich.apiOk', { url: url.slice(-80), fields: Object.keys(result).join(',') });
          break;
        } else {
          // Capture a tiny sample so we can adapt the extractor
          lastBody = JSON.stringify(json).slice(0, 400);
          syncLog('enrich.apiNoSlug', { url: url.slice(-80), bodyHead: lastBody.slice(0, 200) });
        }
      } catch (e) {
        syncLog('enrich.apiErr', { url: url.slice(-80), err: e?.message });
      }
    }

    if (!pageUrl) {
      return {
        ok: false,
        reason: `couldn't resolve URN via Voyager API (last status ${lastStatus}). LinkedIn locks these endpoints down — open the contact in LinkedIn once and the URL will be captured passively.`,
      };
    }
  }

  return { ok: true, enrichment: { profileUrl: pageUrl, ...extra } };
}

// Pull publicIdentifier + role/company/location from any of the Voyager
// profile JSON shapes. Walks `included[]` (Dash format) or top-level fields
// (REST format).
function extractFromVoyager(json) {
  const out = {};
  // Dash response: { data: {...}, included: [...] }
  const included = Array.isArray(json?.included) ? json.included : [];
  // The viewed profile entity will have publicIdentifier
  const profileEntity = included.find((x) => typeof x?.publicIdentifier === 'string')
    || (typeof json?.publicIdentifier === 'string' ? json : null);
  if (profileEntity) {
    if (typeof profileEntity.publicIdentifier === 'string') out.publicIdentifier = profileEntity.publicIdentifier;
    if (typeof profileEntity.headline === 'string') out.headline = profileEntity.headline;
    if (typeof profileEntity.geoLocationName === 'string') out.location = profileEntity.geoLocationName;
    else if (typeof profileEntity.locationName === 'string') out.location = profileEntity.locationName;
    if (typeof profileEntity.industryName === 'string') out.industry = profileEntity.industryName;
  }

  // REST profileView shape: { profile: {...}, positionView: { elements: [...] }, ... }
  const root = json?.profile;
  if (root) {
    if (typeof root.publicIdentifier === 'string' && !out.publicIdentifier) out.publicIdentifier = root.publicIdentifier;
    if (typeof root.miniProfile?.publicIdentifier === 'string' && !out.publicIdentifier) {
      out.publicIdentifier = root.miniProfile.publicIdentifier;
    }
    if (typeof root.headline === 'string' && !out.headline) out.headline = root.headline;
    if (typeof root.locationName === 'string' && !out.location) out.location = root.locationName;
    if (typeof root.industryName === 'string' && !out.industry) out.industry = root.industryName;
  }

  // Positions (REST shape)
  const positions = json?.positionView?.elements || [];
  const current = positions.find((p) => p?.timePeriod && !p.timePeriod.endDate) || positions[0];
  if (current) {
    if (typeof current.title === 'string') out.role = current.title;
    if (typeof current.companyName === 'string') out.company = current.companyName;
  }

  return out;
}

async function getLinkedInAuth() {
  // JSESSIONID gives us the CSRF token; the other cookies travel with fetch
  // automatically when host_permissions matches the URL.
  const cookie = await chrome.cookies.get({ url: 'https://www.linkedin.com/', name: 'JSESSIONID' });
  if (!cookie) return null;
  // JSESSIONID value is wrapped in quotes — strip them
  const csrf = cookie.value.replace(/^"|"$/g, '');
  return { csrf };
}

function liHeaders(csrf) {
  return {
    'csrf-token': csrf,
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'x-li-page-instance': 'urn:li:page:d_flagship3_messaging',
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
  };
}

// Walk a JSON tree, returning all conversation + message objects found
function harvestPayload(json) {
  const conversations = [];
  const messages = [];
  const entities = {};
  const stack = [json];
  const visited = new WeakSet();
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (visited.has(v)) continue;
    visited.add(v);
    if (Array.isArray(v)) { for (const x of v) stack.push(x); continue; }

    if (typeof v.entityUrn === 'string') {
      entities[v.entityUrn] = v;
      const urn = v.entityUrn;
      const type = v.$type || '';
      if ((urn.includes('messagingConversation') || urn.includes('msg_conversation')) &&
          !type.includes('MailboxCount') && !type.includes('QuickReply') && !type.includes('SeenReceipt')) {
        conversations.push({ ...v, _src: 'li' });
      }
      if (urn.includes('msg_message') || urn.includes('messagingMessage') || type.includes('messenger.Message')) {
        messages.push(v);
      }
    }
    for (const val of Object.values(v)) if (val && typeof val === 'object') stack.push(val);
  }
  return { conversations, messages, entities };
}

async function backgroundSync({ broadcastProgress = false } = {}) {
  syncLog('backgroundSync.entry', {});
  let auth;
  try {
    auth = await getLinkedInAuth();
  } catch (e) {
    syncLog('backgroundSync.fail', { reason: 'auth threw', err: e?.message });
    return { ok: false, reason: 'auth threw: ' + (e?.message || 'unknown') };
  }
  syncLog('backgroundSync.auth', { hasAuth: !!auth });
  if (!auth) {
    syncLog('backgroundSync.fail', { reason: 'not-logged-in' });
    return { ok: false, reason: 'not-logged-in' };
  }

  let knownByUrn = {};
  let myProfileUrn = '';
  try {
    const sr = await fetch(`${INBOXPRO_URL}/api/state`);
    if (sr.ok) {
      const sd = await sr.json();
      knownByUrn = sd.conversationsByUrn || {};
      myProfileUrn = sd.myProfileUrn || '';
    }
  } catch (e) {
    syncLog('backgroundSync.stateFetchErr', { err: e?.message });
  }
  syncLog('backgroundSync.state', { knownCount: Object.keys(knownByUrn).length, hasMyUrn: !!myProfileUrn });
  if (!myProfileUrn) {
    syncLog('backgroundSync.fail', { reason: 'no-profile-urn' });
    return { ok: false, reason: 'no-profile-urn — do a manual sync first' };
  }

  // LinkedIn's messengerConversationsByCategoryQuery REQUIRES lastUpdatedBefore.
  // Use a far-future timestamp to get the most recent page of conversations.
  // Fetch every category we care about in parallel so the poll picks up
  // archived/other-tab threads, not just PRIMARY_INBOX.
  const lastUpdatedBefore = Date.now() + 60_000;
  const CATEGORIES = ['PRIMARY_INBOX', 'OTHER', 'ARCHIVE'];
  const buildConvUrl = (category) => {
    // count must stay at 20 — LinkedIn's messengerConversationsByCategoryQuery
    // returns SDK_BUSINESS_LOGIC errors for higher counts (verified via diag log).
    // To go deeper, paginate via lastUpdatedBefore cursor — see backfillCategory.
    const convVars = `(query:(predicateUnions:List((conversationCategoryPredicate:(category:${category})))),count:20,mailboxUrn:${encodeURN(myProfileUrn)},lastUpdatedBefore:${lastUpdatedBefore})`;
    return `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${CONVERSATIONS_QUERY_ID}&variables=${convVars}`;
  };

  syncLog('backgroundSync.convFetch.start', { categories: CATEGORIES });
  const fetchResults = await Promise.all(
    CATEGORIES.map(async (cat) => {
      try {
        const r = await fetch(buildConvUrl(cat), { headers: liHeaders(auth.csrf), credentials: 'include' });
        if (!r.ok) {
          return { cat, ok: false, status: r.status };
        }
        const json = await r.json();
        return { cat, ok: true, status: r.status, json };
      } catch (e) {
        return { cat, ok: false, err: e?.message || 'fetch threw' };
      }
    }),
  );
  syncLog('backgroundSync.convFetch.status', {
    results: fetchResults.map((r) => `${r.cat}=${r.ok ? r.status : (r.err || 'http' + r.status)}`).join(' '),
  });

  // Bail only if EVERY category failed. Partial failure (e.g. ARCHIVE returns
  // 400 for accounts without archived items) is acceptable — we use what worked.
  if (fetchResults.every((r) => !r.ok)) {
    const reasons = fetchResults.map((r) => `${r.cat}:${r.err || r.status}`).join(',');
    syncLog('backgroundSync.fail', { reason: `all categories failed: ${reasons}` });
    return { ok: false, reason: `all categories failed: ${reasons}` };
  }

  // Merge conversations + entities across all successful category fetches.
  const seenConvUrns = new Set();
  const conversations = [];
  const entities = {};
  for (const res of fetchResults) {
    if (!res.ok) continue;
    let harvested;
    try {
      harvested = harvestPayload(res.json);
    } catch (e) {
      syncLog('backgroundSync.harvestErr', { cat: res.cat, err: e?.message });
      continue;
    }
    for (const c of harvested.conversations) {
      if (!c.entityUrn || seenConvUrns.has(c.entityUrn)) continue;
      seenConvUrns.add(c.entityUrn);
      // Tag with source category so the import route can mirror LinkedIn's
      // archive state back to InboxPro (was previously one-way only).
      conversations.push({ ...c, _sourceCategory: res.cat });
    }
    Object.assign(entities, harvested.entities);
  }
  syncLog('backgroundSync.harvest', { convs: conversations.length, cats: fetchResults.filter((r) => r.ok).map((r) => r.cat) });
  if (conversations.length === 0) {
    // Use the first successful response to debug the shape — if the API format
    // changed, all three categories would return the same novel shape.
    const sample = fetchResults.find((r) => r.ok)?.json;
    syncLog('backgroundSync.responseShape', {
      topKeys: Object.keys(sample || {}),
      bodySnippet: JSON.stringify(sample).slice(0, 400),
    });
    syncLog('backgroundSync.fail', { reason: 'zero conversations across all categories' });
    return { ok: true, newConvs: 0, newMsgs: 0, note: 'no conversations in response' };
  }

  // Step 3: identify NEW or CHANGED conversations (compared to app state)
  const changed = conversations.filter((c) => {
    const known = knownByUrn[c.entityUrn];
    if (!known) return true;
    return c.lastActivityAt && c.lastActivityAt > known;
  });
  syncLog('backgroundSync.changed', { changedCount: changed.length });

  if (broadcastProgress) {
    broadcastToInboxPro({
      action: 'refresh-progress',
      message: `Checking ${conversations.length} conversations · ${changed.length} new/changed`,
    });
  }

  // Step 4: fetch messages for each changed conversation (up to 20 to keep it fast)
  const messagesByConv = {};
  const messageEntities = { ...entities };
  const toFetch = changed.slice(0, 20);
  for (const c of toFetch) {
    const urn = c.entityUrn;
    const msgUrl = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${MESSAGES_QUERY_ID}&variables=(conversationUrn:${encodeURN(urn)},count:50)`;
    try {
      const r = await fetch(msgUrl, { headers: liHeaders(auth.csrf), credentials: 'include' });
      if (!r.ok) continue;
      const j = await r.json();
      const harvested = harvestPayload(j);
      if (harvested.messages.length > 0) {
        messagesByConv[urn] = harvested.messages;
      }
      Object.assign(messageEntities, harvested.entities);
    } catch (e) { /* skip */ }
    await new Promise((res) => setTimeout(res, 150));
  }

  syncLog('backgroundSync.diff', {
    totalFromLinkedIn: conversations.length,
    changed: changed.length,
    changedUrns: changed.slice(0, 5).map((c) => c.entityUrn?.slice(-30)),
  });

  // Step 5: POST to app
  if (changed.length > 0 || Object.keys(messagesByConv).length > 0) {
    await pushToApp({
      conversations: changed,
      messages: messagesByConv,
      entities: messageEntities,
      myProfileUrn,
    });
    for (const c of changed) {
      broadcastToInboxPro({ action: 'thread-updated', urn: c.entityUrn, count: 0 });
    }
    syncLog('backgroundSync.pushed', {
      convs: changed.length,
      msgs: Object.values(messagesByConv).reduce((a, b) => a + b.length, 0),
    });
  }

  return { ok: true, newConvs: changed.length, newMsgs: Object.values(messagesByConv).reduce((a, b) => a + b.length, 0) };
}

// ── Recover messages for conversations that got their history wiped ────────
async function recoverMissingMessages({ onProgress }) {
  const auth = await getLinkedInAuth();
  if (!auth) return { ok: false, reason: 'not-logged-in' };

  const r = await fetch(`${INBOXPRO_URL}/api/conversations/sparse`);
  if (!r.ok) return { ok: false, reason: 'cannot reach app' };
  const { ids } = await r.json();
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: true, total: 0, recovered: 0 };
  }

  const headers = liHeaders(auth.csrf);
  let recovered = 0;
  let done = 0;
  const total = ids.length;

  // Pull myProfileUrn from app state so attribution works on the import side
  let storedProfileUrn = '';
  try {
    const sr = await fetch(`${INBOXPRO_URL}/api/state`);
    if (sr.ok) {
      const sd = await sr.json();
      storedProfileUrn = sd.myProfileUrn || '';
    }
  } catch (e) {}

  // Track outcomes for diagnostic reporting
  const failures = { httpErr: 0, parseErr: 0, zeroMsgs: 0, oneMsg: 0 };
  const sample = []; // small sample of problem URLs for the log

  for (const urn of ids) {
    done++;
    const msgUrl = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${MESSAGES_QUERY_ID}&variables=(conversationUrn:${encodeURN(urn)},count:50)`;
    try {
      const resp = await fetch(msgUrl, { headers, credentials: 'include' });
      if (!resp.ok) {
        failures.httpErr++;
        if (sample.length < 3) sample.push(`HTTP ${resp.status}: ${urn.slice(-30)}`);
        continue;
      }
      const text = await resp.text();
      let j;
      try { j = JSON.parse(text); } catch { failures.parseErr++; continue; }
      const harvested = harvestPayload(j);
      if (harvested.messages.length === 0) {
        failures.zeroMsgs++;
        if (sample.length < 3) sample.push(`0 msgs in response: ${urn.slice(-30)}`);
        continue;
      }
      if (harvested.messages.length === 1) {
        failures.oneMsg++;
        // Still POST it — it may have a different message than what's stored
        await pushToApp({
          conversations: [],
          messages: { [urn]: harvested.messages },
          entities: harvested.entities,
          myProfileUrn: storedProfileUrn,
        });
        continue;
      }

      await pushToApp({
        conversations: [],
        messages: { [urn]: harvested.messages },
        entities: harvested.entities,
        myProfileUrn: storedProfileUrn,
      });
      recovered++;
    } catch (e) {
      failures.httpErr++;
    }
    if (done % 10 === 0 || done === total) {
      onProgress?.(`${done}/${total} · ${recovered} recovered · HTTP errors: ${failures.httpErr}, only-1-msg: ${failures.oneMsg}, no-msgs: ${failures.zeroMsgs}`);
    }
    await new Promise((res) => setTimeout(res, 150));
  }

  for (const s of sample) onProgress?.(`sample: ${s}`);
  return { ok: true, total, recovered, ...failures };
}

// ── URL Harvest: scroll-capture every /in/<slug>/ link visible in LinkedIn's
// own UI. Targets the Connections page (every 1st-degree connection has a
// rendered profile link). Same scroll-and-capture mechanic we use for the
// initial messaging sync, retargeted at DOM-level link discovery.
//
// Spam-filter posture: zero LinkedIn API calls. We open the Connections page
// (something the user does themselves all the time), scroll it, and read
// rendered DOM. Indistinguishable from a user browsing their network.
async function harvestConnectionUrls(onProgress) {
  const auth = await getLinkedInAuth();
  if (!auth) return { ok: false, reason: 'not-logged-in' };

  syncLog('harvest.start', {});
  onProgress?.('Opening Connections page…');

  // Open the connections page in a hidden tab
  const tab = await chrome.tabs.create({
    url: 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
    active: false,
  });
  if (!tab?.id) return { ok: false, reason: 'failed to open tab' };

  // Wait for the page to be ready
  try {
    await waitForTabComplete(tab.id, 30_000);
    // React render delay
    await new Promise((r) => setTimeout(r, 2000));
  } catch (e) {
    try { chrome.tabs.remove(tab.id); } catch {}
    return { ok: false, reason: 'page never loaded — ' + (e?.message || 'timeout') };
  }

  // Execute the scroll-and-collect loop in the tab's context. Returns an
  // object { items, samples } so we can see what extraction looks like.
  let collected;
  let samples;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollAndCollectProfiles,
    });
    const raw = result?.result ?? {};
    collected = raw.items ?? [];
    samples = raw.samples ?? {};
    syncLog('harvest.samples', samples);
  } catch (e) {
    syncLog('harvest.scriptErr', { err: e?.message });
    try { chrome.tabs.remove(tab.id); } catch {}
    return { ok: false, reason: 'in-tab script failed: ' + (e?.message || 'unknown') };
  }

  try { chrome.tabs.remove(tab.id); } catch {}

  syncLog('harvest.collected', { count: collected.length });
  onProgress?.(`Captured ${collected.length} links — matching to contacts…`);

  if (collected.length === 0) {
    return { ok: false, reason: 'no profile links found on the page (are you logged in?)' };
  }

  // Push in batches of 200 (server handles all-or-nothing)
  let totalUpdated = 0;
  const BATCH = 200;
  for (let i = 0; i < collected.length; i += BATCH) {
    const slice = collected.slice(i, i + BATCH);
    try {
      const r = await fetch(`${INBOXPRO_URL}/api/profile-capture/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: slice }),
      });
      if (r.ok) {
        const j = await r.json();
        totalUpdated += j.updated ?? 0;
        onProgress?.(`Matched ${totalUpdated} contacts so far…`);
      }
    } catch (e) {
      syncLog('harvest.pushErr', { err: e?.message });
    }
  }

  syncLog('harvest.done', { collected: collected.length, updated: totalUpdated });
  return { ok: true, collected: collected.length, updated: totalUpdated };
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Race condition: chrome.tabs.create may resolve AFTER the tab finished
    // loading, so the onUpdated listener never fires. Poll the tab state too.
    let settled = false;
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      chrome.tabs.onUpdated.removeListener(handler);
      if (err) reject(err);
      else resolve();
    }
    const timer = setTimeout(() => finish(new Error('tab load timeout')), timeoutMs);
    function handler(updatedId, info) {
      if (updatedId === tabId && info.status === 'complete') finish();
    }
    chrome.tabs.onUpdated.addListener(handler);
    // Poll the tab in case it already completed before we attached
    const poll = setInterval(async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t?.status === 'complete') finish();
      } catch (e) {
        // Tab may have been closed externally
        finish(new Error('tab disappeared: ' + (e?.message || 'unknown')));
      }
    }, 800);
  });
}

// Runs IN the connections page's context (via chrome.scripting.executeScript).
// Scrolls + collects every <a href="/in/<slug>/"> with the surrounding name.
// Stops when no new links appear for several rounds OR the hard timeout fires.
function scrollAndCollectProfiles() {
  return new Promise(async (resolve) => {
    const results = new Map(); // normalized URL → display name
    const rawSamples = []; // first 5 anchors with their context, for debug
    const startedAt = Date.now();
    const MAX_TIME_MS = 15 * 60 * 1000;
    const MAX_STABLE_ROUNDS = 8;

    function normalizeUrl(href) {
      try {
        const u = new URL(href, location.origin);
        if (!u.pathname.startsWith('/in/')) return null;
        const segs = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
        if (segs.length < 2 || segs[0] !== 'in') return null;
        const slug = segs[1];
        if (!slug || slug === 'feed') return null;
        return `https://www.linkedin.com/in/${slug}/`;
      } catch {
        return null;
      }
    }

    // Clean a candidate name string — strip "· 1st" / "· 2nd / 3rd+" suffixes,
    // company/role tails after the first separator, etc.
    function cleanName(raw) {
      let s = raw.replace(/\s+/g, ' ').trim();
      // Strip degree indicators
      s = s.replace(/\s*[·•]\s*(1st|2nd|3rd|3rd\+).*$/i, '');
      // If name appears twice ("Aaron Patel Aaron Patel"), keep one
      const dupMatch = s.match(/^(.+?)\s+\1\b/);
      if (dupMatch) s = dupMatch[1];
      // Strip everything after first separator
      s = s.split(/\s+[·•|]\s+/)[0];
      // Drop common UI noise
      s = s.replace(/\b(view|see|profile|connect|message|follow)\b.*$/i, '').trim();
      return s;
    }

    // Pull the leading name-shaped token from a string. The connections page
    // gives us strings like "Kiran KumarSecurity Engineer III, InfraSec" with
    // no space between name and headline, so we have to look for the boundary.
    function leadingName(s) {
      if (!s) return '';
      // Match 2-4 capitalized words at the start (allow initials with periods,
      // hyphenated last names, etc).
      const m = s.match(/^([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+){1,3})/);
      return m ? m[1].trim() : '';
    }

    function nameFromSlug(url) {
      try {
        const u = new URL(url);
        const slug = u.pathname.replace(/^\/in\/|\/+$/g, '');
        const parts = slug.split('-');
        // Drop trailing hash segments (alphanumeric strings 5+ chars are LI noise)
        while (parts.length && /^[a-z0-9]{5,}$/i.test(parts[parts.length - 1])) {
          parts.pop();
        }
        if (parts.length === 0) return '';
        return parts.map((p) => p[0]?.toUpperCase() + p.slice(1)).join(' ');
      } catch {
        return '';
      }
    }

    function extractName(a) {
      const candidates = [];
      const aria = a.getAttribute('aria-label')?.trim();
      if (aria) candidates.push(aria);
      const txt = a.textContent?.replace(/\s+/g, ' ').trim();
      if (txt) candidates.push(txt);

      let parent = a.parentElement;
      for (let i = 0; i < 6 && parent; i++) {
        const spans = parent.querySelectorAll('span[aria-hidden="true"], span.t-16, h2, h3');
        for (const s of spans) {
          const t = s.textContent?.replace(/\s+/g, ' ').trim();
          if (t) candidates.push(t);
        }
        parent = parent.parentElement;
      }

      // Try leading-name extraction first — catches "Kiran KumarSecurity Engineer…"
      for (const raw of candidates) {
        const leading = leadingName(raw);
        if (leading) return leading;
      }

      // Fall back to cleaned-name path
      for (const raw of candidates) {
        const cleaned = cleanName(raw);
        if (!cleaned || cleaned.length < 2 || cleaned.length > 80) continue;
        if (/^(view|see|message|connect|profile|edit|home|my\s|jobs|notifications)/i.test(cleaned)) continue;
        if (!/[A-Za-z]/.test(cleaned)) continue;
        if (/^[A-Z]/.test(cleaned) && cleaned.split(/\s+/).length <= 6) return cleaned;
      }

      // Last-ditch: derive name from the URL slug ("/in/kiran-kumar-abc/" → "Kiran Kumar")
      return nameFromSlug(a.href);
    }

    function harvest() {
      let added = 0;
      const anchors = document.querySelectorAll('a[href*="/in/"]');
      let sampleIdx = 0;
      for (const a of anchors) {
        const url = normalizeUrl(a.href);
        if (!url) continue;
        if (results.has(url)) continue;
        const name = extractName(a);

        // Capture a few raw samples for diagnostics (first 5 ever seen)
        if (rawSamples.length < 5) {
          rawSamples.push({
            url: url.slice(-60),
            extractedName: name,
            ariaLabel: a.getAttribute('aria-label')?.slice(0, 80) || null,
            textContent: a.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80) || null,
          });
        }
        sampleIdx++;

        if (!name) continue;
        results.set(url, name);
        added++;
      }
      return added;
    }

    function clickShowMore() {
      const buttons = document.querySelectorAll('button, a');
      for (const b of buttons) {
        const t = (b.textContent || '').trim().toLowerCase();
        if (t === 'show more results' || t === 'show more' || t === 'see more' || t === 'load more') {
          try { b.click(); return true; } catch {}
        }
      }
      return false;
    }

    // Multi-strategy scroll — LinkedIn's connections page scrolls a nested
    // container, not the window. We try every plausible mechanism.
    function aggressiveScroll() {
      // 1) Window scroll
      window.scrollTo(0, document.documentElement.scrollHeight);

      // 2) Find every scrollable container, scroll it to its bottom
      const scrollables = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while ((node = walker.nextNode())) {
        if (!(node instanceof HTMLElement)) continue;
        const style = getComputedStyle(node);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            node.scrollHeight > node.clientHeight + 10) {
          scrollables.push(node);
        }
      }
      for (const sc of scrollables) {
        sc.scrollTop = sc.scrollHeight;
        sc.dispatchEvent(new Event('scroll', { bubbles: true }));
      }

      // 3) Scroll the last connection card into view
      const cards = document.querySelectorAll('li, [data-test-component], article');
      const last = cards[cards.length - 1];
      if (last) {
        try { last.scrollIntoView({ block: 'end', behavior: 'auto' }); } catch {}
      }

      // 4) Dispatch a wheel event for libraries listening to that
      try {
        document.dispatchEvent(new WheelEvent('wheel', { deltaY: 1000, bubbles: true }));
      } catch {}
    }

    let stable = 0;
    let prev = 0;
    let rounds = 0;
    while (Date.now() - startedAt < MAX_TIME_MS && stable < MAX_STABLE_ROUNDS) {
      rounds++;
      harvest();
      clickShowMore();
      aggressiveScroll();
      await new Promise((r) => setTimeout(r, 1800));
      const after = results.size;
      if (after === prev) stable++;
      else { stable = 0; prev = after; }
    }
    harvest();

    resolve({
      items: Array.from(results.entries()).map(([url, name]) => ({ url, name })),
      samples: {
        rounds,
        anchorCount: document.querySelectorAll('a[href*="/in/"]').length,
        href: location.href.slice(-100),
        firstFew: rawSamples,
      },
    });
  });
}

// ── Backfill: paginate a full LinkedIn category (used for ARCHIVE) ──────────
// Walks every page until LinkedIn returns no further results, tagging each conv
// with `_sourceCategory` so /api/import knows to set status='archived' locally.
async function backfillCategory(category, onProgress) {
  const auth = await getLinkedInAuth();
  if (!auth) return { ok: false, reason: 'not-logged-in' };

  let myProfileUrn = '';
  try {
    const sr = await fetch(`${INBOXPRO_URL}/api/state`);
    if (sr.ok) myProfileUrn = (await sr.json()).myProfileUrn || '';
  } catch {}
  if (!myProfileUrn) return { ok: false, reason: 'no-profile-urn — run a full sync first' };

  let cursor = Date.now() + 60_000;
  let pageNum = 0;
  let totalConvs = 0;
  let totalMsgs = 0;
  // count:20 is LinkedIn's max for this endpoint (higher returns
  // SDK_BUSINESS_LOGIC null). Compensate by allowing more pages.
  const PAGE_SIZE = 20;
  const MAX_PAGES = 250; // hard safety cap (= 5000 convs)
  const headers = liHeaders(auth.csrf);

  syncLog('backfill.start', { category });
  onProgress?.(`Backfilling ${category}…`);

  while (pageNum < MAX_PAGES) {
    pageNum++;
    const convVars = `(query:(predicateUnions:List((conversationCategoryPredicate:(category:${category})))),count:${PAGE_SIZE},mailboxUrn:${encodeURN(myProfileUrn)},lastUpdatedBefore:${cursor})`;
    const url = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${CONVERSATIONS_QUERY_ID}&variables=${convVars}`;

    let json;
    try {
      const r = await fetch(url, { headers, credentials: 'include' });
      if (!r.ok) {
        syncLog('backfill.fail', { category, page: pageNum, status: r.status });
        return { ok: false, reason: `HTTP ${r.status} on page ${pageNum}`, totalConvs, totalMsgs };
      }
      json = await r.json();
    } catch (e) {
      syncLog('backfill.fail', { category, page: pageNum, err: e?.message });
      return { ok: false, reason: e?.message || 'fetch threw', totalConvs, totalMsgs };
    }

    // Detect LinkedIn's GraphQL error envelope (HTTP 200 with errors[]
    // inside). Tells us our query was rejected (bad count, bad params, etc).
    const innerErrors = json?.data?.data?.errors || json?.errors;
    if (Array.isArray(innerErrors) && innerErrors.length > 0) {
      const first = innerErrors[0];
      const reason = `GraphQL error: ${first?.extensions?.code || 'unknown'} on page ${pageNum}`;
      syncLog('backfill.fail', { category, page: pageNum, reason, sample: JSON.stringify(first).slice(0, 200) });
      return { ok: false, reason, totalConvs, totalMsgs };
    }

    const { conversations, messages, entities } = harvestPayload(json);
    if (conversations.length === 0) {
      syncLog('backfill.done', { category, pages: pageNum, totalConvs, totalMsgs });
      onProgress?.(`Backfill done — ${totalConvs} convs across ${pageNum} pages`);
      break;
    }

    // Tag and find the oldest lastActivityAt to use as the next cursor
    let nextCursor = cursor;
    const tagged = conversations.map((c) => {
      if (typeof c.lastActivityAt === 'number' && c.lastActivityAt < nextCursor) {
        nextCursor = c.lastActivityAt;
      }
      return { ...c, _sourceCategory: category };
    });

    // Build a messages-by-conv map. Note: the conv-list response embeds short
    // message summaries — these still go to /api/import for attribution
    // recovery.
    const messagesByConv = {};
    for (const m of messages) {
      const convUrn = m.conversation?.entityUrn ||
        m.conversationUrn ||
        m['*conversation'] ||
        '';
      if (!convUrn) continue;
      if (!messagesByConv[convUrn]) messagesByConv[convUrn] = [];
      messagesByConv[convUrn].push(m);
    }

    const push = await pushToApp({
      conversations: tagged,
      messages: messagesByConv,
      entities,
      myProfileUrn,
    });
    if (!push.ok) {
      syncLog('backfill.pushFail', { category, page: pageNum, reason: push.reason });
      return { ok: false, reason: `push failed page ${pageNum}: ${push.reason}`, totalConvs, totalMsgs };
    }

    totalConvs += conversations.length;
    totalMsgs += messages.length;
    onProgress?.(`Page ${pageNum}: ${conversations.length} convs · ${totalConvs} total`);

    // If the cursor didn't advance, LinkedIn is returning the same page — stop.
    if (nextCursor >= cursor) {
      syncLog('backfill.cursorStall', { category, page: pageNum, cursor });
      break;
    }
    cursor = nextCursor;
    await new Promise((res) => setTimeout(res, 250)); // be gentle to LinkedIn
  }

  return { ok: true, totalConvs, totalMsgs, pages: pageNum };
}

// ── Alarm: closed-tab background sync ────────────────────────────────────────
// Fires every 5 min even with all InboxPro/LinkedIn tabs closed, so the inbox
// stays fresh when you wake your laptop or have Chrome open without InboxPro.
// chrome.alarms persists across browser restarts; the listener must be
// re-registered each time the service worker starts (i.e. top-level in
// background.js — that's why this is at module scope, not inside onInstalled).
const ALARM_NAME = 'inboxpro-background-sync';
// Profile-enrichment alarm: periodically opens 1-3 contact profiles in hidden
// tabs to silently capture role/company via the existing profile-capture.js
// content script. Throttled to ~human pace.
const ENRICH_ALARM = 'inboxpro-profile-enrich';
// Sales Navigator inbox refresh — hits SN's API directly, no SN tab needed.
const SN_ALARM = 'inboxpro-sn-sync';
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });
  chrome.alarms.create(ENRICH_ALARM, { periodInMinutes: 15 });
  chrome.alarms.create(SN_ALARM, { delayInMinutes: 0.1, periodInMinutes: 3 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });
  chrome.alarms.create(ENRICH_ALARM, { periodInMinutes: 15 });
  chrome.alarms.create(SN_ALARM, { delayInMinutes: 0.1, periodInMinutes: 3 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    syncLog('alarm.fire', { name: alarm.name });
    backgroundSync({ broadcastProgress: false }).catch((e) => {
      syncLog('alarm.error', { err: e?.message });
    });
  } else if (alarm.name === ENRICH_ALARM) {
    syncLog('alarm.fire', { name: alarm.name });
    processProfileEnrichmentQueue().catch((e) => {
      syncLog('autoEnrich.fail', { err: e?.message });
    });
  } else if (alarm.name === SN_ALARM) {
    syncLog('alarm.fire', { name: alarm.name });
    snBackgroundSync().catch((e) => {
      syncLog('snAlarm.error', { err: e?.message });
    });
  }
});

// ── SN background sync ─────────────────────────────────────────────────────
// Fetches SN inbox first page (most recent 20 threads) and feeds to the parser.
// Runs on alarm, no SN tab required. Idempotent — the server upserts.
const SN_INBOX_DECORATION =
  '(id,restrictions,archived,unreadMessageCount,nextPageStartsAt,totalMessageCount,' +
  'messages*(id,type,contentFlag,deliveredAt,lastEditedAt,subject,body,footerText,' +
  'blockCopy,attachments,author,systemMessageContent),' +
  'participants*~fs_salesProfile(entityUrn,firstName,lastName,fullName,degree,' +
  'profilePictureDisplayImage,objectUrn,inmailRestriction))';

// encodeURIComponent leaves ( ) * ' ! literal — SN's rest.li rejects those.
function snEnc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function snHeaders(csrf) {
  return {
    'csrf-token': csrf,
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'x-li-track': '{"clientVersion":"1.0.0","mpVersion":"1.0.0","osName":"web","timezoneOffset":0,"timezone":"UTC","deviceFormFactor":"DESKTOP","mpName":"sales-web-app"}',
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
  };
}

async function snBackgroundSync() {
  syncLog('snBg.entry', {});
  const auth = await getLinkedInAuth();
  if (!auth) {
    syncLog('snBg.skip', { reason: 'not-logged-in' });
    return;
  }
  // First page only — catches anything new since last sync without
  // hammering SN. Full deep-fetch only happens when the user clicks the
  // button in the SN tab.
  const url = `https://www.linkedin.com/sales-api/salesApiMessagingThreads?decoration=${snEnc(SN_INBOX_DECORATION)}&count=20&filter=INBOX&pageStartsAt=${Date.now()}&q=filter`;
  let body;
  try {
    const r = await fetch(url, { headers: snHeaders(auth.csrf), credentials: 'include' });
    if (!r.ok) {
      syncLog('snBg.fetchFail', { status: r.status });
      return;
    }
    body = await r.text();
  } catch (e) {
    syncLog('snBg.fetchErr', { err: e?.message });
    return;
  }

  // Hand off to the same parser used by the foreground sync
  try {
    const res = await fetch(`${INBOXPRO_URL}/api/import/sales-nav-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    const j = await res.json().catch(() => ({}));
    syncLog('snBg.done', {
      ok: res.ok,
      threads: j.threadsFound ?? 0,
      convsTouched: j.convsTouched ?? 0,
      inserted: j.inserted ?? 0,
    });
  } catch (e) {
    syncLog('snBg.importErr', { err: e?.message });
  }
}

// Open up to N profile URLs that need role/company, one at a time in hidden
// tabs, ~30s apart. profile-capture.js fires automatically when the /in/<slug>
// page loads (it's registered as a content script for that pattern), so we
// just need to give it time to extract + post + then close the tab.
async function processProfileEnrichmentQueue() {
  let items;
  try {
    const r = await fetch(`${INBOXPRO_URL}/api/conversations/needs-profile-fetch?limit=3`);
    if (!r.ok) {
      syncLog('autoEnrich.skip', { reason: `endpoint HTTP ${r.status}` });
      return;
    }
    const data = await r.json();
    items = Array.isArray(data.items) ? data.items : [];
  } catch (e) {
    syncLog('autoEnrich.skip', { reason: `fetch threw: ${e?.message}` });
    return;
  }

  if (items.length === 0) {
    syncLog('autoEnrich.idle', { reason: 'queue empty' });
    return;
  }

  syncLog('autoEnrich.batch', { count: items.length });

  for (let i = 0; i < items.length; i++) {
    const { id, profileUrl } = items[i];
    let tab;
    try {
      tab = await chrome.tabs.create({ url: profileUrl, active: false });
      await waitForTabComplete(tab.id, 20_000);
      // React + content-script render delay. profile-capture.js posts to the
      // server during this window.
      await new Promise((r) => setTimeout(r, 5000));
      syncLog('autoEnrich.processed', { id: id?.slice(-30), url: profileUrl.slice(-50) });
    } catch (e) {
      syncLog('autoEnrich.error', { err: e?.message });
    } finally {
      if (tab?.id != null) {
        try { await chrome.tabs.remove(tab.id); } catch {}
      }
    }
    // Throttle: 30s gap between fetches so behavior looks like a human
    // poking at a few profiles, not a scraper.
    if (i < items.length - 1) {
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'openApp') {
    (async () => {
      const ok = await pushToApp({
        conversations: message.conversations || [],
        messages: message.messages || {},
        entities: message.entities || {},
        myProfileUrn: message.myProfileUrn || '',
      });
      if (ok) {
        await chrome.storage.local.set({
          lastSyncedAt: new Date().toISOString(),
          conversationCount: (message.conversations || []).length,
          messageCount: Object.values(message.messages || {}).reduce((a, b) => a + b.length, 0),
        });
        await openApp();
        sendResponse({ success: true });
      } else {
        sendResponse({ error: 'Could not reach localhost:3030. Is InboxPro running?' });
      }
    })();
    return true;
  }
  if (message.action === 'notify') {
    showNotification({
      title: message.title,
      body: message.body,
      convId: message.convId,
    });
    sendResponse({ ok: true });
    return false;
  }
  if (message.action === 'fullSync') {
    (async () => {
      try {
        // Find or open a LinkedIn messaging tab, then trigger the content script's runSync.
        let [liTab] = await chrome.tabs.query({ url: '*://www.linkedin.com/messaging*' });
        if (!liTab) {
          broadcastToInboxPro({ action: 'refresh-progress', message: 'Opening LinkedIn messaging tab…' });
          liTab = await chrome.tabs.create({ url: 'https://www.linkedin.com/messaging', active: false });
          await new Promise((resolve) => {
            const listener = (tabId, info) => {
              if (tabId === liTab.id && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });
        }
        await chrome.scripting.executeScript({ target: { tabId: liTab.id }, files: ['content.js'] }).catch(() => {});
        broadcastToInboxPro({ action: 'refresh-progress', message: 'Scrolling and capturing inbox…' });
        const result = await chrome.tabs.sendMessage(liTab.id, { action: 'sync' });
        if (result?.error) {
          sendResponse({ ok: false, reason: result.error });
          return;
        }
        syncLog('fullSync.harvested', {
          convs: result?.count || 0,
          msgs: result?.messageCount || 0,
        });
        // Push the captured payload to the app
        const push = await pushToApp({
          conversations: result?.conversations || [],
          messages: result?.messages || {},
          entities: result?.entities || {},
          myProfileUrn: result?.myProfileUrn || '',
        });
        if (!push.ok) {
          sendResponse({
            ok: false,
            reason: `Push to app failed: ${push.reason}`,
            count: result?.count || 0,
            messageCount: result?.messageCount || 0,
          });
          return;
        }
        sendResponse({ ok: true, count: result?.count || 0, messageCount: result?.messageCount || 0 });
      } catch (e) {
        syncLog('fullSync.exception', { err: e?.message });
        sendResponse({ ok: false, reason: e?.message || 'fullSync failed' });
      }
    })();
    return true;
  }
  if (message.action === 'refreshNow') {
    (async () => {
      const silent = !!message.silent;
      const result = await backgroundSync({ broadcastProgress: !silent });
      // Only broadcast refresh-complete for non-silent (user-initiated) calls.
      // Silent polls already trigger thread-updated broadcasts when something
      // actually changes — no need for a noisy "Up to date" UI flash.
      if (!silent) {
        broadcastToInboxPro({ action: 'refresh-complete', result });
      }
      sendResponse(result);
    })();
    return true;
  }
  if (message.action === 'liApiDebugDump') {
    (async () => {
      const result = await debugLinkedInApi();
      sendResponse(result);
    })();
    return true;
  }
  if (message.action === 'liInitialSyncApi') {
    (async () => {
      const result = await linkedInInitialSyncApi({
        deepFetch: message.deepFetch !== false,
        onProgress: (p) => {
          broadcastToInboxPro({ action: 'li-api-sync-progress', progress: p });
        },
      });
      sendResponse(result);
    })();
    return true;
  }
  if (message.action === 'snRefreshNow') {
    (async () => {
      try { await snBackgroundSync(); } catch (e) { syncLog('snRefreshNow.err', { err: e?.message }); }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message.action === 'recoverMessages') {
    (async () => {
      broadcastToInboxPro({ action: 'refresh-progress', message: 'Extension received recover request, starting…' });
      const result = await recoverMissingMessages({
        onProgress: (msg) => {
          broadcastToInboxPro({ action: 'refresh-progress', message: msg });
        },
      });
      sendResponse(result);
    })();
    return true;
  }
  if (message.action === 'inspectThread') {
    (async () => {
      const auth = await getLinkedInAuth();
      if (!auth) return sendResponse({ ok: false, reason: 'not-logged-in' });
      const url = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${MESSAGES_QUERY_ID}&variables=(conversationUrn:${encodeURN(message.urn)},count:50)`;
      try {
        const r = await fetch(url, { headers: liHeaders(auth.csrf), credentials: 'include' });
        const text = await r.text();
        sendResponse({ ok: true, status: r.status, raw: text });
      } catch (e) {
        sendResponse({ ok: false, reason: e?.message });
      }
    })();
    return true;
  }
  if (message.action === 'refreshThread') {
    (async () => {
      syncLog('refreshThread.start', { urn: message.urn?.slice(-30) });
      const auth = await getLinkedInAuth();
      if (!auth) {
        syncLog('refreshThread.fail', { reason: 'not-logged-in' });
        return sendResponse({ ok: false, reason: 'not-logged-in' });
      }
      const urn = message.urn;
      const url = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${MESSAGES_QUERY_ID}&variables=(conversationUrn:${encodeURN(urn)},count:50)`;
      try {
        const r = await fetch(url, { headers: liHeaders(auth.csrf), credentials: 'include' });
        if (!r.ok) {
          syncLog('refreshThread.fail', { urn: urn?.slice(-30), status: r.status });
          return sendResponse({ ok: false, reason: `HTTP ${r.status}` });
        }
        const j = await r.json();
        const harvested = harvestPayload(j);
        if (harvested.messages.length === 0) {
          return sendResponse({ ok: true, count: 0 });
        }
        // Push just this conversation's messages — /api/import upserts and won't wipe
        let storedProfileUrn = '';
        try {
          const sr = await fetch(`${INBOXPRO_URL}/api/state`);
          if (sr.ok) storedProfileUrn = (await sr.json()).myProfileUrn || '';
        } catch {}
        await pushToApp({
          // Pass conversations too — LinkedIn's messages response embeds the
          // conv object, which means brand-new conversations get proper
          // participant data on the first hit instead of waiting for a sync.
          conversations: harvested.conversations,
          messages: { [urn]: harvested.messages },
          entities: harvested.entities,
          myProfileUrn: storedProfileUrn,
        });
        broadcastToInboxPro({
          action: 'thread-updated',
          urn,
          count: harvested.messages.length,
        });
        syncLog('refreshThread.ok', {
          urn: urn?.slice(-30),
          msgs: harvested.messages.length,
          convs: harvested.conversations.length,
        });
        sendResponse({ ok: true, count: harvested.messages.length });
      } catch (e) {
        sendResponse({ ok: false, reason: e?.message || 'fetch threw' });
      }
    })();
    return true;
  }
  if (message.action === 'typing') {
    (async () => {
      // No-op for SN convs (typing isn't reachable — see project memory).
      const urn = message.conversationUrn;
      if (typeof urn === 'string' && urn.startsWith('sn:')) {
        sendResponse({ ok: true, skipped: 'sn' });
        return;
      }
      const result = await sendLinkedInTyping({ conversationUrn: urn });
      sendResponse(result);
    })();
    return true;
  }
  if (message.action === 'sendMessage') {
    (async () => {
      // Route by conv id: SN convs start with "sn:"; everything else is LinkedIn.
      const isSnConv = typeof message.conversationUrn === 'string' && message.conversationUrn.startsWith('sn:');
      const result = isSnConv
        ? await sendSnMessage({ threadId: message.conversationUrn, body: message.body })
        : await sendLinkedInMessage({
            conversationUrn: message.conversationUrn,
            body: message.body,
          });
      sendResponse(result);
    })();
    return true;
  }
  if (message.action === 'mirror') {
    (async () => {
      const urn = message.urn;
      const isSn = typeof urn === 'string' && urn.startsWith('sn:');
      const result = isSn
        ? await mirrorToSn({ kind: message.kind, urn })
        : await mirrorToLinkedIn({
            kind: message.kind,
            urn,
            value: message.value,
          });
      sendResponse(result);
    })();
    return true;
  }
  if (message.action === 'harvestConnections') {
    (async () => {
      const result = await harvestConnectionUrls((msg) => {
        broadcastToInboxPro({ action: 'refresh-progress', message: msg });
      });
      sendResponse(result);
    })();
    return true;
  }
  if (message.action === 'backfillCategory') {
    (async () => {
      const result = await backfillCategory(message.category || 'ARCHIVE', (msg) => {
        broadcastToInboxPro({ action: 'refresh-progress', message: msg });
      });
      sendResponse(result);
    })();
    return true;
  }
  if (message.action === 'enrichProfile') {
    syncLog('enrich.bgReceived', {
      hasUrl: !!message.profileUrl,
      hasUrn: !!message.profileUrn,
    });
    (async () => {
      const result = await enrichLinkedInProfile({
        profileUrn: message.profileUrn,
        profileUrl: message.profileUrl,
      });
      sendResponse(result);
    })();
    return true;
  }
  // Realtime push: content.js captured new data from a LinkedIn fetch and just
  // POSTed it to /api/import. We just need to tell every InboxPro tab so it
  // refreshes the affected thread.
  if (message.action === 'broadcastThreadUpdated') {
    broadcastToInboxPro({
      action: 'thread-updated',
      urn: message.urn,
      count: message.count || 0,
    });
    sendResponse({ ok: true });
    return false;
  }
});
