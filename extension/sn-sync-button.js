// Sales Navigator sync — API-driven, three phases.
//
//   Phase 1: inbox pagination
//     /sales-api/salesApiMessagingThreads?q=filter&filter=INBOX&pageStartsAt=<ts>
//     → captures every conv + the latest message preview
//   Phase 2: per-thread deep fetch
//     /sales-api/salesApiMessagingThreads/<id>?messageCount=N
//     → full message history per thread (concurrency 2, backoff on 429)
//   Phase 3: profile enrichment
//     /sales-api/salesApiProfiles/(profileId:X,authType:NAME_SEARCH,authToken:Y)
//     → contact headlines (the inbox/thread endpoints don't carry them)
//
// All fetches go from the content script (same origin, auth via cookies + csrf
// header). Server-side parsers handle the response shapes. No DOM scraping,
// no dependency on SN's UI firing requests.

(() => {
  if (window.__inboxproSnSyncBtn) return;
  window.__inboxproSnSyncBtn = true;

  const INBOXPRO_URL = 'http://localhost:3030';

  function isInboxPath() {
    return /\/sales\/(inbox|messaging|messages)\b/.test(location.pathname);
  }

  function logEv(ev, extra = {}) {
    fetch(`${INBOXPRO_URL}/api/sync-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: 'sn-sync', ev, ...extra }),
    }).catch(() => {});
  }
  logEv('sn.script.loaded', { path: location.pathname, isInbox: isInboxPath(), trigger: 'initial' });

  // ── SN API helpers ────────────────────────────────────────────────────────
  function csrfToken() {
    const m = document.cookie.match(/JSESSIONID=([^;]+)/);
    if (!m) return '';
    return m[1].replace(/^"|"$/g, '');
  }
  const apiHeaders = () => ({
    'csrf-token': csrfToken(),
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'x-li-track': '{"clientVersion":"1.0.0","mpVersion":"1.0.0","osName":"web","timezoneOffset":0,"timezone":"UTC","deviceFormFactor":"DESKTOP","mpName":"sales-web-app"}',
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // encodeURIComponent doesn't escape ( ) * ! ' but SN's API REJECTS them
  // unencoded in the decoration param. Patch the result to RFC 3986 strict.
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase());

  const INBOX_DECORATION =
    '(id,restrictions,archived,unreadMessageCount,nextPageStartsAt,totalMessageCount,' +
    'messages*(id,type,contentFlag,deliveredAt,lastEditedAt,subject,body,footerText,' +
    'blockCopy,attachments,author,systemMessageContent),' +
    'participants*~fs_salesProfile(entityUrn,firstName,lastName,fullName,degree,' +
    'profilePictureDisplayImage,objectUrn,inmailRestriction))';

  const THREAD_DECORATION = INBOX_DECORATION; // same shape per-thread

  const PROFILE_DECORATION =
    '(listCount,crmStatus,degree,entityUrn,teamlink,objectUrn,firstName,lastName,' +
    'fullName,headline,inmailRestriction,location,pendingInvitation,' +
    'profilePictureDisplayImage,savedLead,contactInfo,blockThirdPartyDataSharing,' +
    'colleague,memberBadges,defaultPosition)';

  // GET wrapper with 429 backoff. Returns { status, body } where body is text.
  async function getJson(url, retries = 3) {
    while (true) {
      const r = await fetch(url, { credentials: 'include', headers: apiHeaders() });
      if (r.status === 429 && retries > 0) {
        await sleep(3000 + Math.random() * 2000);
        retries--;
        continue;
      }
      const body = await r.text();
      return { status: r.status, ok: r.ok, body };
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @keyframes inboxpro-sn-fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes inboxpro-sn-pulse { 0%,100% { box-shadow: 0 8px 24px rgba(37,99,235,.24), 0 0 0 0 rgba(37,99,235,.30); } 50% { box-shadow: 0 8px 24px rgba(37,99,235,.18), 0 0 0 6px rgba(37,99,235,0); } }
    @keyframes inboxpro-sn-spin { to { transform: rotate(360deg); } }
    #inboxpro-sn-card {
      position: fixed; bottom: 24px; right: 24px; z-index: 99999;
      background: #fff; color: #18181B;
      border: 1px solid #E5E5E5; border-radius: 14px;
      padding: 12px 14px; min-width: 280px; max-width: 340px;
      box-shadow: 0 12px 28px rgba(0,0,0,.12), 0 2px 6px rgba(0,0,0,.06);
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      font-size: 13px;
      animation: inboxpro-sn-fade-in 280ms cubic-bezier(.25,1,.5,1);
      -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      #inboxpro-sn-card { background: #161616; color: #FAFAFA; border-color: #262626; }
      .inboxpro-sn-progress { color: #A1A1A1 !important; }
      .inboxpro-sn-phase { color: #71717A !important; }
      .inboxpro-sn-close { color: #71717A !important; }
      .inboxpro-sn-close:hover { background: #1E1E1E !important; color: #FAFAFA !important; }
    }
    .inboxpro-sn-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .inboxpro-sn-tile {
      width: 28px; height: 28px; border-radius: 8px;
      background: rgba(37,99,235,.10); color: #1D4ED8;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; font-weight: 700; font-size: 13px;
    }
    .inboxpro-sn-title { flex: 1; font-weight: 600; font-size: 13px; }
    .inboxpro-sn-close {
      background: none; border: none; cursor: pointer; padding: 4px;
      border-radius: 6px; color: #A1A1AA;
      display: flex; align-items: center; justify-content: center;
      transition: all 140ms cubic-bezier(.25,1,.5,1);
    }
    .inboxpro-sn-close:hover { background: #F4F4F5; color: #18181B; }
    .inboxpro-sn-btn {
      width: 100%; padding: 8px 12px; background: #1D4ED8; color: white;
      border: none; border-radius: 8px; font-size: 12.5px; font-weight: 600;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      gap: 6px; transition: all 160ms cubic-bezier(.25,1,.5,1);
      font-family: inherit;
    }
    .inboxpro-sn-btn:hover:not(:disabled) { background: #2563EB; transform: translateY(-1px); }
    .inboxpro-sn-btn:active:not(:disabled) { transform: scale(.98); }
    .inboxpro-sn-btn:disabled { cursor: not-allowed; opacity: .85; }
    .inboxpro-sn-btn--running { animation: inboxpro-sn-pulse 1.8s ease-in-out infinite; }
    .inboxpro-sn-btn--done { background: #16A34A; }
    .inboxpro-sn-phase {
      margin-top: 8px; font-size: 11.5px; font-weight: 500; color: #52525B;
      letter-spacing: -.005em;
    }
    .inboxpro-sn-progress {
      margin-top: 2px; font-size: 11px; color: #71717A;
      font-family: ui-monospace, SFMono-Regular, monospace;
      min-height: 14px;
    }
    .inboxpro-sn-spin { display: inline-flex; animation: inboxpro-sn-spin .9s linear infinite; }
  `;
  document.head.appendChild(style);

  const iconDownload = `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
  const iconSpin = `<span class="inboxpro-sn-spin"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span>`;
  const iconCheck = `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

  function mountCard() {
    if (document.getElementById('inboxpro-sn-card')) return;
    const card = document.createElement('div');
    card.id = 'inboxpro-sn-card';
    card.innerHTML = `
      <div class="inboxpro-sn-header">
        <div class="inboxpro-sn-tile">i</div>
        <div class="inboxpro-sn-title">InboxPro · Sales Nav sync</div>
        <button class="inboxpro-sn-close" id="inboxpro-sn-close" title="Hide" aria-label="Hide">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <button class="inboxpro-sn-btn" id="inboxpro-sn-btn">
        <span id="inboxpro-sn-btn-icon">${iconDownload}</span>
        <span id="inboxpro-sn-btn-label">Sync this SN inbox</span>
      </button>
      <div class="inboxpro-sn-phase" id="inboxpro-sn-phase"></div>
      <div class="inboxpro-sn-progress" id="inboxpro-sn-progress"></div>
    `;
    document.body.appendChild(card);

    const btn = document.getElementById('inboxpro-sn-btn');
    const btnLabel = document.getElementById('inboxpro-sn-btn-label');
    const btnIcon = document.getElementById('inboxpro-sn-btn-icon');
    const phaseEl = document.getElementById('inboxpro-sn-phase');
    const progEl = document.getElementById('inboxpro-sn-progress');
    const closeEl = document.getElementById('inboxpro-sn-close');

    let running = false;
    closeEl.addEventListener('click', () => { if (!running) card.style.display = 'none'; });

    function setUi(state, label, phase, progress) {
      btn.className = 'inboxpro-sn-btn' + (state === 'running' ? ' inboxpro-sn-btn--running' : state === 'done' ? ' inboxpro-sn-btn--done' : '');
      btnIcon.innerHTML = state === 'running' ? iconSpin : state === 'done' ? iconCheck : iconDownload;
      btnLabel.textContent = label;
      phaseEl.textContent = phase || '';
      progEl.textContent = progress || '';
    }

    btn.addEventListener('click', async () => {
      if (running) return;
      running = true;
      btn.disabled = true;

      // ── Probe: hit a verbatim captured URL to check infrastructure ──
      // If this returns 200, our URL construction is the bug. If it 400s,
      // we're missing headers/auth that SN's own JS adds.
      setUi('running', 'Probing…', 'Checking SN auth', '');
      const probeUrl = '/sales-api/salesApiMessagingThreads?decoration=%28id%2Crestrictions%2Carchived%2CunreadMessageCount%2CnextPageStartsAt%2CtotalMessageCount%2Cmessages*%28id%2Ctype%2CcontentFlag%2CdeliveredAt%2ClastEditedAt%2Csubject%2Cbody%2CfooterText%2CblockCopy%2Cattachments%2Cauthor%2CsystemMessageContent%29%2Cparticipants*~fs_salesProfile%28entityUrn%2CfirstName%2ClastName%2CfullName%2Cdegree%2CprofilePictureDisplayImage%2CobjectUrn%2CinmailRestriction%29%29&count=20&filter=INBOX&pageStartsAt=' + Date.now() + '&q=filter';
      const probe = await getJson(probeUrl);
      logEv('sn.probe.result', {
        status: probe.status,
        ok: probe.ok,
        bodyPreview: probe.body.slice(0, 400),
        urlLen: probeUrl.length,
        csrfLen: csrfToken().length,
      });
      if (!probe.ok) {
        setUi('done', 'Probe failed', `Phase 1 unreachable (${probe.status})`, 'See sn.probe.result in log');
        btn.disabled = false;
        running = false;
        return;
      }

      const t0 = Date.now();
      const totals = {
        pages: 0, threads: 0, convsImported: 0,
        deepThreads: 0, deepMsgs: 0, deepErrs: 0, deepStatuses: {},
        profilesFetched: 0, profilesPatched: 0,
      };

      // ── Phase 1: inbox pagination ──
      setUi('running', 'Syncing inbox…', 'Phase 1 of 3 — Inbox', '0 pages · 0 threads');
      const allThreadIds = new Set();
      const allParticipantUrns = new Set();
      let pageStartsAt = '';
      let safety = 200; // hard cap on pages

      while (safety-- > 0) {
        // First page uses now() as cursor (SN paginates back in time); subsequent
        // pages use the smallest nextPageStartsAt from previous response.
        const cursor = pageStartsAt || String(Date.now());
        const url = `/sales-api/salesApiMessagingThreads?decoration=${enc(INBOX_DECORATION)}&count=20&filter=INBOX&pageStartsAt=${cursor}&q=filter`;
        const { ok, status, body } = await getJson(url);
        if (!ok) {
          logEv('sn.phase1.fail', { status, page: totals.pages, url: url.slice(0, 400), body: body.slice(0, 400) });
          break;
        }

        let parsed;
        try { parsed = JSON.parse(body); } catch { break; }
        const els = parsed?.data?.elements || [];
        if (els.length === 0) break;

        // Track ids + participant URNs for later phases
        for (const t of els) {
          if (t?.id) allThreadIds.add(t.id);
          if (Array.isArray(t?.participants)) {
            for (const purn of t.participants) {
              if (typeof purn === 'string') allParticipantUrns.add(purn);
            }
          }
        }

        // Send the raw body to the server parser
        try {
          const res = await fetch(`${INBOXPRO_URL}/api/import/sales-nav-messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
          });
          if (res.ok) {
            const j = await res.json().catch(() => ({}));
            totals.convsImported += (j.convsTouched ?? 0);
          }
        } catch {}

        totals.pages++;
        totals.threads = allThreadIds.size;
        setUi('running', 'Syncing inbox…', 'Phase 1 of 3 — Inbox',
          `${totals.pages} pages · ${totals.threads} threads`);

        // Pagination cursor: smallest nextPageStartsAt across this page's threads
        const cursors = els.map((t) => t?.nextPageStartsAt).filter((n) => typeof n === 'number');
        if (cursors.length === 0) break;
        const next = Math.min(...cursors);
        if (!next || next === Infinity || String(next) === pageStartsAt) break;
        pageStartsAt = String(next);
        await sleep(250);
      }

      logEv('sn.phase1.done', {
        pages: totals.pages, threads: totals.threads, ms: Date.now() - t0,
      });

      // ── Phase 2: per-thread deep fetch ──
      const threadList = Array.from(allThreadIds);
      const t1 = Date.now();
      setUi('running', 'Loading history…', 'Phase 2 of 3 — Messages',
        `0 / ${threadList.length} threads`);

      const failureSamples = [];
      async function deepFetch(tid, retries = 2) {
        const url = `/sales-api/salesApiMessagingThreads/${tid}?decoration=${enc(THREAD_DECORATION)}&count=1&messageCount=50`;
        const { ok, status, body } = await getJson(url);
        const sk = String(status);
        totals.deepStatuses[sk] = (totals.deepStatuses[sk] || 0) + 1;
        if (status === 429 && retries > 0) {
          await sleep(4000);
          return deepFetch(tid, retries - 1);
        }
        if (!ok) {
          if (failureSamples.length < 3) {
            failureSamples.push({ status, tid: tid.slice(0, 30), body: body.slice(0, 280) });
          }
          totals.deepErrs++;
          return;
        }
        // Single-thread response: { data: {<thread>}, included: [...] }
        // Our parser expects { data: { elements: [...] }, included }. Rewrap.
        let wrapped = body;
        try {
          const j = JSON.parse(body);
          if (j?.data && !Array.isArray(j.data.elements) && j.data.id) {
            j.data = { elements: [j.data] };
            wrapped = JSON.stringify(j);
          }
        } catch {}
        try {
          const res = await fetch(`${INBOXPRO_URL}/api/import/sales-nav-messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: wrapped }),
          });
          if (res.ok) {
            const j = await res.json().catch(() => ({}));
            totals.deepMsgs += j.inserted ?? 0;
          }
        } catch {}
      }

      // Concurrency 2 to stay under SN's rate limit
      let idx = 0;
      async function deepWorker() {
        while (idx < threadList.length) {
          const my = idx++;
          await deepFetch(threadList[my]);
          totals.deepThreads++;
          if (my % 10 === 0) {
            setUi('running', 'Loading history…', 'Phase 2 of 3 — Messages',
              `${totals.deepThreads} / ${threadList.length} · ${totals.deepMsgs} msgs · ${totals.deepErrs} err`);
          }
          await sleep(200);
        }
      }
      await Promise.all([deepWorker(), deepWorker()]);

      logEv('sn.phase2.done', {
        threads: totals.deepThreads,
        msgs: totals.deepMsgs,
        errs: totals.deepErrs,
        statuses: totals.deepStatuses,
        failSamples: failureSamples,
        ms: Date.now() - t1,
      });

      // ── Phase 3: profile enrichment (runs in BACKGROUND) ──
      // Phase 1+2 are the user-visible sync. Phase 3 keeps fetching headlines
      // silently after the button reports "Done". The phase line updates as
      // profiles come in but the button stays in 'done' state.

      // Report Phase 1+2 done immediately
      const phase12Ms = Date.now() - t0;
      logEv('sn.sync.done.v2', {
        ...totals, totalMs: phase12Ms, phase3InBackground: true,
      });
      setUi('done',
        `${totals.threads} convs · ${totals.deepMsgs} msgs`,
        `Done in ${Math.round(phase12Ms / 1000)}s · enriching headlines in background`,
        `${totals.deepErrs} errors`);
      btn.disabled = false;
      running = false;

      // Skip URNs we already have a real headline for — saves time and avoids
      // re-fetching contacts the CSV match already enriched.
      let needHeadline = new Set();
      try {
        const r = await fetch(`${INBOXPRO_URL}/api/import/sales-nav-profile/needed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urns: Array.from(allParticipantUrns) }),
        });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.needed)) needHeadline = new Set(j.needed);
        }
      } catch {}
      const profUrns = needHeadline.size > 0
        ? Array.from(needHeadline)
        : Array.from(allParticipantUrns);
      const t2 = Date.now();

      // URN format: urn:li:fs_salesProfile:(profileId,authType,authToken)
      function parseSalesProfileUrn(urn) {
        const m = urn.match(/urn:li:fs_salesProfile:\(([^,]+),([^,]+),([^)]+)\)/);
        if (!m) return null;
        return { profileId: m[1], authType: m[2], authToken: m[3] };
      }

      async function fetchProfile(urn, retries = 2) {
        const parts = parseSalesProfileUrn(urn);
        if (!parts) return;
        // Profile path uses (profileId:X,authType:Y,authToken:Z) — those ARE
        // literal in SN's URL so don't encode the outer parens, but the
        // decoration must use strict encoding.
        const url = `/sales-api/salesApiProfiles/(profileId:${parts.profileId},authType:${parts.authType},authToken:${parts.authToken})?decoration=${enc(PROFILE_DECORATION)}`;
        const { ok, status, body } = await getJson(url);
        if (status === 429 && retries > 0) { await sleep(4000); return fetchProfile(urn, retries - 1); }
        if (!ok) return;
        try {
          const res = await fetch(`${INBOXPRO_URL}/api/import/sales-nav-profile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
          });
          if (res.ok) {
            const j = await res.json().catch(() => ({}));
            totals.profilesFetched++;
            if ((j.patched ?? 0) > 0) totals.profilesPatched += j.patched;
          }
        } catch {}
      }

      let pidx = 0;
      async function profWorker() {
        while (pidx < profUrns.length) {
          const my = pidx++;
          await fetchProfile(profUrns[my]);
          if (my % 20 === 0) {
            setUi('running', 'Enriching contacts…', 'Phase 3 of 3 — Profiles',
              `${totals.profilesFetched} / ${profUrns.length} · ${totals.profilesPatched} patched`);
          }
          await sleep(75);
        }
      }
      // Concurrency 4 — profiles are smaller responses than threads, can go faster
      await Promise.all([profWorker(), profWorker(), profWorker(), profWorker()]);

      logEv('sn.phase3.done', {
        urns: profUrns.length,
        fetched: totals.profilesFetched,
        patched: totals.profilesPatched,
        ms: Date.now() - t2,
      });

      // Update the progress line one final time when background work finishes
      // (button stays in 'done' state — user can keep working)
      const card = document.getElementById('inboxpro-sn-card');
      if (card) {
        const p = document.getElementById('inboxpro-sn-progress');
        if (p) p.textContent = `${totals.profilesPatched} headlines added · ${totals.deepErrs} errors`;
      }
    });
  }

  // Re-mount on SPA navigation
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (isInboxPath() && !document.getElementById('inboxpro-sn-card')) {
      mountCard();
    } else if (!isInboxPath() && document.getElementById('inboxpro-sn-card')) {
      const c = document.getElementById('inboxpro-sn-card');
      if (c) c.remove();
    }
  }, 1500);

  if (isInboxPath()) mountCard();
})();
