// Relay side panel — the extension's primary surface. Renders in Chrome's own
// side panel (NOT injected into linkedin.com), so it never modifies LinkedIn's
// page. Jobs:
//   1. "On this profile" — who this person is to you (Relay context: existing
//      messages + their source, AI summary, ICP fit, follow-up, labels), an
//      Import button, and AI Draft reply.
//   2. "Search Relay" — find anyone you've talked to, jump to their profile.
//   3. "Sync inbox" — LinkedIn / Sales Navigator syncs (moved from the popup).

const RELAY = 'http://localhost:3030';
const el = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiny DOM builder — keeps all user content as text nodes (no innerHTML for data).
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const c of kids) { if (c == null) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return e;
}

const connDot = el('connDot'), connText = el('connText');
const profileEmpty = el('profileEmpty'), profileBody = el('profileBody');
const profileName = el('profileName'), profileHeadline = el('profileHeadline');
const profilePills = el('profilePills'), profileContext = el('profileContext');
const importBtn = el('importBtn');
const searchInput = el('searchInput'), searchResults = el('searchResults');
const syncBtn = el('syncBtn'), snSyncBtn = el('snSyncBtn'), connSyncBtn = el('connSyncBtn'), connFullBtn = el('connFullBtn');
const progressEl = el('progress'), hintEl = el('hint');
const captureSection = el('captureSection'), captureStatus = el('captureStatus');
const captureChecklist = el('captureChecklist'), captureDoneBtn = el('captureDoneBtn');

const SYNC_IDLE = `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;
const SYNC_RUN = `<svg width="14" height="14" class="spin" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 .49-4.79"></path></svg>`;

// ── Connection ───────────────────────────────────────────────────────────
async function checkConnection() {
  try { return (await fetch(`${RELAY}/api/state`, { signal: AbortSignal.timeout(2500) })).ok; }
  catch { return false; }
}
function renderConnection(ok) {
  connDot.className = 'conn-dot ' + (ok ? 'on' : 'off');
  connText.textContent = ok ? 'Connected' : 'App not running';
  // The hint line only appears when there's actually something to say —
  // disconnected (or a sync error sets it). Avoids a permanent scary banner.
  if (ok) { hintEl.style.display = 'none'; }
  else { hintEl.style.display = 'block'; hintEl.textContent = 'Open the Relay app and keep it running.'; }
}

// ── Active tab → current profile ─────────────────────────────────────────
function slugFromUrl(url) {
  const m = (url || '').match(/^https?:\/\/www\.linkedin\.com\/in\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}
// Read-only page read for display (name/headline) when the person isn't in
// Relay yet. Reading the DOM isn't injection — nothing is added or persisted.
async function readProfileDisplay(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        // Name: the profile's main <h1> is the person's name. Fall back to the
        // page <title> ("(12) Mark Overton | LinkedIn" → "Mark Overton").
        let name = clean(document.querySelector('main h1, h1')?.textContent);
        if (!name) name = clean(document.title).replace(/^\(\d+\+?\)\s*/, '').replace(/\s*\|\s*LinkedIn.*$/i, '').trim();
        let headline = clean(document.querySelector('.text-body-medium.break-words')?.textContent);
        if (!headline) headline = clean(document.querySelector('meta[property="og:description"]')?.getAttribute('content'));
        return { name, headline };
      },
    });
    return res?.result || { name: '', headline: '' };
  } catch { return { name: '', headline: '' }; }
}
async function fetchContext(slug, name) {
  try {
    const u = `${RELAY}/api/contacts/by-slug/${encodeURIComponent(slug)}/context`
      + (name ? `?name=${encodeURIComponent(name)}` : '');
    const r = await fetch(u, { signal: AbortSignal.timeout(4000) });
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

let currentSlug = null, currentTabId = null;

async function renderProfile() {
  const tab = await getActiveTab();
  const slug = tab ? slugFromUrl(tab.url) : null;
  currentSlug = slug;
  currentTabId = tab?.id ?? null;
  profileContext.replaceChildren();
  profilePills.replaceChildren();

  if (!slug) { profileBody.classList.add('hidden'); profileEmpty.classList.remove('hidden'); return; }
  profileEmpty.classList.add('hidden'); profileBody.classList.remove('hidden');

  // Read the page name first so the context lookup can fall back to name-match
  // (most contacts have no slug stored — they came from message sync).
  const page = await readProfileDisplay(tab.id);
  if (currentSlug !== slug) return;
  const ctx = await fetchContext(slug, page.name);
  if (currentSlug !== slug) return; // navigated away mid-fetch

  const c = ctx?.contact;
  profileName.textContent = (ctx?.exists && c?.name) || page.name || slug.replace(/-+/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase());
  profileHeadline.textContent = (ctx?.exists && c?.headline) || page.headline || '';

  if (ctx?.exists) {
    renderContext(ctx);
    importBtn.className = 'btn secondary small';
    importBtn.textContent = 'Re-import';
  } else {
    profilePills.append(h('span', { class: 'pill' }, h('span', { class: 'pip' }), 'Not in Relay yet'));
    importBtn.className = 'btn small';
    importBtn.textContent = 'Import to Relay';
  }
  importBtn.disabled = false;
}

function renderContext(ctx) {
  const convs = ctx.conversations || [];
  // Pills: In Relay · ICP fit · follow-up · labels (deduped).
  profilePills.append(h('span', { class: 'pill in' }, h('span', { class: 'pip' }), 'In Relay'));
  const icp = convs.find((v) => v.aiIcpFit != null || v.manualIcp);
  if (icp) {
    const txt = icp.manualIcp ? 'ICP ★' : `ICP ${icp.aiIcpFit}%`;
    profilePills.append(h('span', { class: 'pill icp' }, txt));
  }
  const fu = convs.find((v) => v.followUpAt);
  if (fu) {
    const d = new Date(fu.followUpAt);
    profilePills.append(h('span', { class: 'pill followup' }, `Follow up ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`));
  }
  const seen = new Set();
  for (const v of convs) for (const l of (v.labels || [])) {
    if (seen.has(l.name)) continue; seen.add(l.name);
    profilePills.append(h('span', { class: 'pill label' }, l.name));
    if (seen.size >= 3) break;
  }

  // AI summary (first thread that has one).
  const sum = convs.find((v) => v.aiSummary)?.aiSummary;
  if (sum) profileContext.append(h('div', { class: 'ai-summary', text: sum }));

  // Threads — messages + where they're from + Draft reply.
  for (const v of convs) {
    const thread = h('div', { class: 'thread' });
    const isSn = v.source === 'sales_nav';
    thread.append(h('div', { class: 'thread-head' },
      h('span', { class: 'src-badge' + (isSn ? ' sn' : '') }, v.sourceLabel || v.source),
      h('span', { class: 'pill', style: 'font-size:10px;background:none;padding:0;color:var(--text-muted)' },
        v.lastMessageAt ? new Date(v.lastMessageAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''),
    ));
    const msgs = (v.messages || []).slice(-4);
    if (!msgs.length) thread.append(h('div', { class: 'msg' }, h('span', { class: 'txt' }, 'No messages yet.')));
    for (const m of msgs) {
      thread.append(h('div', { class: 'msg' + (m.isFromMe ? ' me' : '') },
        h('span', { class: 'who' }, (m.isFromMe ? 'You' : (m.senderName || 'Them')) + ': '),
        h('span', { class: 'txt' }, m.body.length > 180 ? m.body.slice(0, 180) + '…' : m.body),
      ));
    }
    const draftBtn = h('button', { class: 'btn tiny secondary', style: 'margin-top:8px' }, 'Draft reply');
    const draftSlot = h('div');
    draftBtn.addEventListener('click', () => draftReply(v.id, draftBtn, draftSlot));
    thread.append(draftBtn, draftSlot);
    profileContext.append(thread);
  }
}

// ── AI Draft reply ───────────────────────────────────────────────────────
async function draftReply(conversationId, btn, slot) {
  btn.disabled = true;
  btn.innerHTML = `${SYNC_RUN} Drafting…`;
  slot.replaceChildren();
  try {
    const r = await fetch(`${RELAY}/api/ai/draft-reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    });
    const d = await r.json();
    if (!r.ok) { slot.append(h('div', { class: 'hint', style: 'color:var(--danger)' }, d.error || 'Draft failed')); return; }
    const drafts = d.drafts || [];
    if (!drafts.length) { slot.append(h('div', { class: 'hint' }, 'No draft returned. Add an API key in Settings?')); return; }
    for (const text of drafts) {
      const box = h('div', { class: 'draft-box' }, h('div', { class: 'draft-text', text }));
      const copyBtn = h('button', { class: 'btn tiny secondary' }, 'Copy');
      copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(text); copyBtn.textContent = 'Copied ✓'; setTimeout(() => (copyBtn.textContent = 'Copy'), 1400); } catch {}
      });
      box.append(h('div', { class: 'draft-actions' }, copyBtn));
      slot.append(box);
    }
  } catch (e) {
    slot.append(h('div', { class: 'hint', style: 'color:var(--danger)' }, 'Draft failed — is the Relay app running?'));
  } finally {
    btn.disabled = false; btn.textContent = 'Draft reply';
  }
}

// ── Import current profile ───────────────────────────────────────────────
importBtn.addEventListener('click', async () => {
  if (!currentSlug || currentTabId == null) return;
  const slug = currentSlug;
  importBtn.disabled = true;
  importBtn.innerHTML = `${SYNC_RUN} Importing…`;
  progressEl.textContent = '';

  // Self-contained import: read the profile straight from the page (one-shot,
  // no persistent injection) and POST to /api/profile-capture. The endpoint
  // matches the contact by name and attaches this profile's slug + URL — which
  // is exactly the link that was missing (message-synced contacts have no
  // slug). No dependency on content scripts being present in the tab.
  const info = await readProfileDisplay(currentTabId);
  if (!info.name) {
    importBtn.disabled = false; importBtn.textContent = 'Import to Relay';
    progressEl.textContent = 'Could not read this profile — reload the LinkedIn tab and retry.';
    return;
  }
  const url = `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`;
  try {
    const r = await fetch(`${RELAY}/api/profile-capture`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, name: info.name, headline: info.headline || undefined }),
    });
    if (!r.ok) {
      importBtn.disabled = false; importBtn.textContent = 'Import to Relay';
      progressEl.textContent = 'Import failed — is the Relay app running?';
      return;
    }
  } catch {
    importBtn.disabled = false; importBtn.textContent = 'Import to Relay';
    progressEl.textContent = 'Import failed — is the Relay app running?';
    return;
  }
  // Best-effort: also ask the content script to do the rich in-page scrape
  // (About / Experience / Education / Posts). The thin POST above already
  // guaranteed name + slug landed; this enriches when the content script is
  // present on the tab. Silently ignored if it isn't.
  try { await chrome.tabs.sendMessage(currentTabId, { action: 'relay-import-current-profile' }); } catch {}
  // The capture write is synchronous; re-check a couple times to be safe.
  for (let i = 0; i < 5; i++) {
    await sleep(800);
    if (currentSlug !== slug) return;
    const ctx = await fetchContext(slug, info.name);
    if (ctx?.exists) { renderProfile(); return; }
  }
  renderProfile();
});

// ── Search Relay ─────────────────────────────────────────────────────────
let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { searchResults.replaceChildren(); return; }
  searchTimer = setTimeout(() => runSearch(q), 250);
});
async function runSearch(q) {
  try {
    const r = await fetch(`${RELAY}/api/contacts/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return;
    const d = await r.json();
    searchResults.replaceChildren();
    const list = (d.contacts || []).slice(0, 8);
    if (!list.length) { searchResults.append(h('div', { class: 'hint' }, 'No matches.')); return; }
    for (const c of list) {
      const url = c.profileUrl || (c.profileSlug ? `https://www.linkedin.com/in/${c.profileSlug}` : null);
      const sub = [c.role || c.headline, c.company].filter(Boolean).join(' · ');
      const row = h('div', { class: 'result' },
        h('div', { class: 'result-name', text: c.name || 'Unknown' }),
        sub ? h('div', { class: 'result-sub', text: sub }) : null,
      );
      if (url) row.addEventListener('click', () => chrome.tabs.create({ url }));
      else row.style.opacity = '0.6';
      searchResults.append(row);
    }
  } catch {}
}

// ── Sync (LinkedIn + Sales Navigator) ────────────────────────────────────
function runSync(btn, idleLabel, action, payload, onResult) {
  const other = btn === syncBtn ? snSyncBtn : syncBtn;
  btn.disabled = true; other.disabled = true;
  btn.innerHTML = `${SYNC_RUN} Syncing…`;
  progressEl.textContent = '';
  chrome.runtime.sendMessage({ action, ...payload }, (response) => {
    btn.disabled = false; other.disabled = false;
    btn.innerHTML = `${SYNC_IDLE} ${idleLabel}`;
    if (chrome.runtime.lastError) { progressEl.textContent = 'Error: ' + chrome.runtime.lastError.message; return; }
    if (!response?.ok) {
      const reason = response?.reason ?? 'Unknown error';
      progressEl.textContent = 'Failed: ' + reason;
      if (/not-logged-in/i.test(reason)) { hintEl.style.display = 'block'; hintEl.textContent = 'Sign into LinkedIn in this browser, then retry.'; }
      return;
    }
    onResult(response);
    renderProfile();
  });
}
syncBtn.addEventListener('click', () => runSync(syncBtn, 'Sync LinkedIn inbox', 'liInitialSyncApi', { deepFetch: true }, (r) => {
  progressEl.textContent = `Synced ${r.convs ?? r.count ?? 0} conversations · ${r.msgs ?? r.messageCount ?? 0} messages`;
}));
snSyncBtn.addEventListener('click', () => runSync(snSyncBtn, 'Sync Sales Navigator', 'snFullSyncApi', {}, (r) => {
  progressEl.textContent = `Synced ${r.threads ?? 0} SN threads · ${r.deepMsgs ?? 0} messages`;
}));

// Connections sync — opens the Connections page so its API response is
// captured (connectedAt + company + avatar) and imported. Incremental by
// default (stops at already-known connections); Full resync walks everything.
function runConnSync(fullResync) {
  connSyncBtn.disabled = true; if (connFullBtn) connFullBtn.disabled = true;
  connSyncBtn.innerHTML = `${SYNC_RUN} ${fullResync ? 'Full resync…' : 'Syncing connections…'}`;
  progressEl.textContent = '';
  chrome.runtime.sendMessage({ action: 'harvestConnections', fullResync }, (response) => {
    connSyncBtn.disabled = false; if (connFullBtn) connFullBtn.disabled = false;
    connSyncBtn.innerHTML = `${SYNC_IDLE} Sync connections`;
    if (chrome.runtime.lastError) { progressEl.textContent = 'Error: ' + chrome.runtime.lastError.message; return; }
    progressEl.textContent = response?.ok
      ? `Synced ${response.collected ?? 0} connections — dates & companies updating.`
      : `Failed: ${response?.reason ?? 'error'}`;
    renderProfile();
  });
}
connSyncBtn?.addEventListener('click', () => runConnSync(false));
connFullBtn?.addEventListener('click', () => runConnSync(true));

// ── Profile-capture status (replaces the old on-page popup) ───────────────
// The profile-capture content script messages us with checklist progress
// during a Refresh-profile capture. We render it here in the panel and offer
// the "Done" button — nothing is drawn over LinkedIn anymore.
let captureTabId = null;
let captureHideTimer = null;

const CAP_ITEMS = [
  ['about', 'About'],
  ['experience', 'Experience'],
  ['education', 'Education'],
  ['posts', 'Posts'],
];

function renderCaptureStatus(state, tabId) {
  if (!captureSection) return;
  clearTimeout(captureHideTimer);

  if (!state || state.phase === 'idle') {
    captureSection.classList.add('hidden');
    return;
  }
  captureTabId = tabId ?? captureTabId;
  captureSection.classList.remove('hidden');

  const c = state.captured || {};
  // Status line.
  if (state.phase === 'finishing') {
    captureStatus.textContent = typeof state.countdown === 'number'
      ? `Saving — back to Relay in ${state.countdown}s`
      : 'Saving…';
    captureDoneBtn.disabled = true;
    captureDoneBtn.textContent = 'Saving…';
  } else if (state.phase === 'done') {
    captureStatus.textContent = 'Captured ✓';
    captureDoneBtn.style.display = 'none';
    captureHideTimer = setTimeout(() => captureSection.classList.add('hidden'), 2500);
  } else {
    captureStatus.textContent = 'Scroll the profile — we capture sections as they load.';
    captureDoneBtn.disabled = false;
    captureDoneBtn.style.display = '';
    captureDoneBtn.textContent = 'Done — use what we have';
  }

  // Checklist pills.
  captureChecklist.replaceChildren(...CAP_ITEMS.map(([key, label]) => {
    const on = key === 'posts' ? (c.posts || 0) > 0 : !!c[key];
    const text = key === 'posts' ? `${label} (${c.posts || 0})` : label;
    return h('span', { class: 'pill' }, `${on ? '✓' : '·'} ${text}`);
  }));
}

captureDoneBtn?.addEventListener('click', () => {
  if (captureTabId == null) return;
  captureDoneBtn.disabled = true;
  try { chrome.tabs.sendMessage(captureTabId, { action: 'relay-capture-done' }); } catch {}
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.action === 'progress' && typeof msg.message === 'string') progressEl.textContent = msg.message;
  if (msg?.action === 'relay-capture-status') {
    renderCaptureStatus(msg, sender?.tab?.id);
  }
});

// ── Keep profile section current as tabs change ──────────────────────────
chrome.tabs.onActivated.addListener(() => renderProfile());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status === 'complete') getActiveTab().then((t) => { if (t && t.id === tabId) renderProfile(); });
});

// ── Boot ─────────────────────────────────────────────────────────────────
(async function boot() {
  renderConnection(await checkConnection());
  await renderProfile();
})();
setInterval(() => checkConnection().then(renderConnection), 8000);
