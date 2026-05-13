// Floating "Harvest URLs" button on LinkedIn's Connections page.
//
// Why this exists: background-tab harvests fail because LinkedIn's connections
// page doesn't fully lazy-load when hidden — only 10 cards render. Running on
// the user's ACTIVE tab works correctly because the page renders normally.
//
// User flow:
//   1. User navigates to linkedin.com/mynetwork/invite-connect/connections/
//   2. Floating button appears bottom-right
//   3. Click → scrolls + collects every /in/<slug>/ link → POSTs to InboxPro
//   4. Shows live count + final summary

(() => {
  if (window.__inboxproHarvestBtn) return;
  window.__inboxproHarvestBtn = true;

  const INBOXPRO_URL = 'http://localhost:3030';

  // --- Inject styles + keyframes once ---
  const style = document.createElement('style');
  style.textContent = `
    @keyframes inboxpro-fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes inboxpro-pulse {
      0%, 100% { box-shadow: 0 8px 24px rgba(37, 99, 235, 0.24), 0 0 0 0 rgba(37, 99, 235, 0.30); }
      50%      { box-shadow: 0 8px 24px rgba(37, 99, 235, 0.18), 0 0 0 6px rgba(37, 99, 235, 0); }
    }
    @keyframes inboxpro-spin { to { transform: rotate(360deg); } }
    #inboxpro-harvest-card {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 99999;
      background: #FFFFFF;
      color: #18181B;
      border: 1px solid #E5E5E5;
      border-radius: 14px;
      padding: 12px 14px;
      min-width: 248px;
      max-width: 320px;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.06);
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
      font-size: 13px;
      animation: inboxpro-fade-in 280ms cubic-bezier(0.25, 1, 0.5, 1);
      -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      #inboxpro-harvest-card {
        background: #161616;
        color: #FAFAFA;
        border-color: #262626;
      }
      .inboxpro-harvest-progress { color: #A1A1A1 !important; }
      .inboxpro-harvest-close { color: #71717A !important; }
      .inboxpro-harvest-close:hover { background: #1E1E1E !important; color: #FAFAFA !important; }
    }
    .inboxpro-harvest-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .inboxpro-harvest-tile {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: rgba(37, 99, 235, 0.10);
      color: #1D4ED8;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-weight: 700;
      font-size: 13px;
      letter-spacing: -0.02em;
    }
    .inboxpro-harvest-title {
      flex: 1;
      font-weight: 600;
      font-size: 13px;
      letter-spacing: -0.005em;
    }
    .inboxpro-harvest-close {
      background: none;
      border: none;
      cursor: pointer;
      padding: 4px;
      border-radius: 6px;
      color: #A1A1AA;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 140ms cubic-bezier(0.25, 1, 0.5, 1);
      font-family: inherit;
    }
    .inboxpro-harvest-close:hover { background: #F4F4F5; color: #18181B; }
    .inboxpro-harvest-btn {
      width: 100%;
      padding: 8px 12px;
      background: #1D4ED8;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 160ms cubic-bezier(0.25, 1, 0.5, 1);
      font-family: inherit;
      letter-spacing: -0.005em;
    }
    .inboxpro-harvest-btn:hover:not(:disabled) {
      background: #2563EB;
      transform: translateY(-1px);
    }
    .inboxpro-harvest-btn:active:not(:disabled) { transform: scale(0.98); }
    .inboxpro-harvest-btn:disabled { cursor: not-allowed; opacity: 0.85; }
    .inboxpro-harvest-btn--running { animation: inboxpro-pulse 1.8s ease-in-out infinite; }
    .inboxpro-harvest-btn--done { background: #16A34A; }
    .inboxpro-harvest-progress {
      margin-top: 8px;
      font-size: 11px;
      color: #71717A;
      font-family: ui-monospace, SFMono-Regular, monospace;
      letter-spacing: -0.01em;
      min-height: 14px;
    }
    .inboxpro-harvest-warn {
      margin-top: 8px;
      padding: 6px 10px;
      border-radius: 8px;
      background: rgba(217, 119, 6, 0.10);
      border: 1px solid rgba(217, 119, 6, 0.25);
      color: #92400E;
      font-size: 10.5px;
      line-height: 1.35;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    @media (prefers-color-scheme: dark) {
      .inboxpro-harvest-warn {
        background: rgba(217, 119, 6, 0.14);
        border-color: rgba(217, 119, 6, 0.30);
        color: #FCD34D;
      }
    }
    .inboxpro-harvest-spin {
      display: inline-flex;
      animation: inboxpro-spin 0.9s linear infinite;
    }
  `;
  document.head.appendChild(style);

  // --- UI ---
  const card = document.createElement('div');
  card.id = 'inboxpro-harvest-card';

  const iconIdle = `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
    <polyline points="7 10 12 15 17 10"></polyline>
    <line x1="12" y1="15" x2="12" y2="3"></line>
  </svg>`;
  const iconSpinner = `<span class="inboxpro-harvest-spin"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
  </svg></span>`;
  const iconCheck = `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>`;

  card.innerHTML = `
    <div class="inboxpro-harvest-header">
      <div class="inboxpro-harvest-tile">i</div>
      <div class="inboxpro-harvest-title">InboxPro · Harvest URLs</div>
      <button class="inboxpro-harvest-close" id="inboxpro-harvest-close" title="Hide" aria-label="Hide">
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
    <button class="inboxpro-harvest-btn" id="inboxpro-harvest-btn">
      <span id="inboxpro-harvest-btn-icon">${iconIdle}</span>
      <span id="inboxpro-harvest-btn-label">Scroll &amp; harvest connections</span>
    </button>
    <div class="inboxpro-harvest-progress" id="inboxpro-harvest-progress"></div>
    <div class="inboxpro-harvest-warn">
      <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" style="flex-shrink:0">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
      Keep this tab focused while running — LinkedIn pauses loading on background tabs.
    </div>
  `;

  document.body.appendChild(card);
  const btn = document.getElementById('inboxpro-harvest-btn');
  const btnLabel = document.getElementById('inboxpro-harvest-btn-label');
  const btnIcon = document.getElementById('inboxpro-harvest-btn-icon');
  const progressEl = document.getElementById('inboxpro-harvest-progress');
  const closeEl = document.getElementById('inboxpro-harvest-close');

  closeEl.addEventListener('click', () => {
    if (running) return;
    card.style.display = 'none';
  });

  function setState(state, label, progress) {
    btn.className = 'inboxpro-harvest-btn' + (state === 'running' ? ' inboxpro-harvest-btn--running' : state === 'done' ? ' inboxpro-harvest-btn--done' : '');
    btnIcon.innerHTML = state === 'running' ? iconSpinner : state === 'done' ? iconCheck : iconIdle;
    btnLabel.textContent = label;
    if (progress != null) progressEl.textContent = progress;
  }

  let running = false;

  // --- Helpers ---
  function normalizeUrl(href) {
    try {
      const u = new URL(href, location.origin);
      if (!u.pathname.startsWith('/in/')) return null;
      const segs = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (segs.length < 2 || segs[0] !== 'in') return null;
      const slug = segs[1];
      if (!slug || slug === 'feed') return null;
      return `https://www.linkedin.com/in/${slug}/`;
    } catch { return null; }
  }

  function leadingName(s) {
    if (!s) return '';
    // Chop at any lowercase→uppercase boundary — that's the name|role mash
    // ("Kiran KumarSecurity Engineer..." → "Kiran Kumar")
    const boundary = s.search(/\p{Ll}\p{Lu}/u);
    if (boundary > 0) s = s.slice(0, boundary + 1);
    // Then grab 2-4 capitalized words (allows unicode names, initials with dots)
    const m = s.match(/^(\p{Lu}[\p{Ll}'\-]+(?:\s+\p{Lu}[\p{Ll}.'\-]*\.?){1,3})/u);
    if (m) return m[1].trim();
    // Single-word fallback: short string with one capitalized word + no mash
    const single = s.match(/^(\p{Lu}[\p{Ll}'\-]{1,30})/u);
    if (single && s.length < 30) return single[1].trim();
    return '';
  }

  function nameFromSlug(url) {
    try {
      const u = new URL(url);
      const slug = u.pathname.replace(/^\/in\/|\/+$/g, '');
      const parts = slug.split('-');
      while (parts.length && /^[a-z0-9]{5,}$/i.test(parts[parts.length - 1])) parts.pop();
      if (parts.length === 0) return '';
      return parts.map((p) => p[0]?.toUpperCase() + p.slice(1)).join(' ');
    } catch { return ''; }
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

    for (const raw of candidates) {
      const leading = leadingName(raw);
      if (leading) return leading;
    }
    return nameFromSlug(a.href);
  }

  function aggressiveScroll() {
    // Window scroll
    window.scrollTo(0, document.documentElement.scrollHeight);

    // Body scroll (sometimes the page has explicit overflow on <body>)
    try { document.body.scrollTop = document.body.scrollHeight; } catch {}

    // Find every scrollable nested container and scroll it to bottom
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (!(node instanceof HTMLElement)) continue;
      const style = getComputedStyle(node);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          node.scrollHeight > node.clientHeight + 10) {
        node.scrollTop = node.scrollHeight;
        node.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
    }

    // Scroll the last visible card into view — triggers intersection-observer
    // based lazy loaders
    const cards = document.querySelectorAll('[data-view-name="profile-component"], li[componentkey], li.artdeco-list__item, li, [data-test-component], article');
    const last = cards[cards.length - 1];
    if (last) {
      try { last.scrollIntoView({ block: 'end', behavior: 'auto' }); } catch {}
    }

    // Dispatch both scroll and wheel events for whichever the page is listening on
    try {
      document.dispatchEvent(new WheelEvent('wheel', { deltaY: 1200, bubbles: true }));
      window.dispatchEvent(new Event('scroll', { bubbles: true }));
    } catch {}
  }

  // When lazy-load stalls, simulate what the user does manually: scroll up
  // a chunk, then back down to bottom. Wakes LinkedIn's intersection observer.
  async function scrollBounce() {
    const top = Math.max(0, window.scrollY - 800);
    window.scrollTo({ top, behavior: 'auto' });
    await new Promise((r) => setTimeout(r, 700));
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((r) => setTimeout(r, 500));
    window.dispatchEvent(new Event('scroll', { bubbles: true }));
  }

  function clickShowMore() {
    // LinkedIn uses several patterns for "load more" — match by text substring
    // since the exact phrasing changes ("Show all (1,234) connections", etc).
    const candidates = document.querySelectorAll('button, a[role="button"]');
    let clicked = false;
    for (const b of candidates) {
      const t = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!t || t.length > 60) continue;
      if (
        /^show more results?$/.test(t) ||
        /^show more$/.test(t) ||
        /^see more$/.test(t) ||
        /^load more$/.test(t) ||
        /^show all/.test(t) ||
        /^view all/.test(t) ||
        /^see all/.test(t) ||
        /^more results$/.test(t)
      ) {
        try {
          b.scrollIntoView({ block: 'center' });
          b.click();
          clicked = true;
        } catch {}
      }
    }
    return clicked;
  }

  async function run() {
    if (running) return;
    running = true;
    btn.disabled = true;

    const results = new Map();
    const MAX_TIME_MS = 60 * 60 * 1000;
    // Be very patient: only give up after ~2 minutes of zero new results in a
    // row. LinkedIn frequently pauses lazy-load on big networks for 10-30s
    // before resuming, and we don't want to bail early when there's still a
    // long tail to fetch.
    const MAX_STABLE_ROUNDS = 60;
    const SCROLL_WAIT_MS = 2000;
    const startedAt = Date.now();
    let rounds = 0;
    let stable = 0;
    let prev = 0;
    let lastClicked = false;

    function extractAvatar(a) {
      // Find the nearest <img> — either inside the anchor or in a sibling
      // within ~3 levels up. LinkedIn typically renders the photo as a sibling.
      const inside = a.querySelector('img[src*="media.licdn.com"], img[src*="profile-displayphoto"]');
      if (inside?.src) return inside.src;
      let parent = a.parentElement;
      for (let i = 0; i < 4 && parent; i++) {
        const img = parent.querySelector('img[src*="media.licdn.com"], img[src*="profile-displayphoto"]');
        if (img?.src) return img.src;
        parent = parent.parentElement;
      }
      return null;
    }

    function harvest() {
      for (const a of document.querySelectorAll('a[href*="/in/"]')) {
        const url = normalizeUrl(a.href);
        if (!url || results.has(url)) continue;
        const name = extractName(a);
        if (!name) continue;
        results.set(url, { name, avatarUrl: extractAvatar(a) });
      }
    }

    setState('running', 'Scrolling…', '0 found');

    while (Date.now() - startedAt < MAX_TIME_MS && stable < MAX_STABLE_ROUNDS) {
      rounds++;
      harvest();
      lastClicked = clickShowMore();
      aggressiveScroll();

      // When stalled for 5+ rounds, mimic the user's manual scroll-up-then-down
      // gesture every 3rd stall round — wakes LinkedIn's intersection observer
      // when normal scroll-to-bottom isn't triggering it.
      let bounced = false;
      if (stable >= 5 && stable % 3 === 0) {
        await scrollBounce();
        bounced = true;
      }

      await new Promise((r) => setTimeout(r, SCROLL_WAIT_MS));
      const after = results.size;
      const stallNote = stable > 3 ? ` · stalled ${stable}/${MAX_STABLE_ROUNDS}` : '';
      const clickNote = lastClicked ? ' · clicked "Show more"' : bounced ? ' · bouncing scroll' : '';
      setState('running', 'Scrolling…', `${after} found · r${rounds}${clickNote}${stallNote}`);
      if (after === prev) stable++;
      else { stable = 0; prev = after; }
    }
    harvest();

    setState('running', 'Sending to InboxPro…', `${results.size} links`);

    const items = Array.from(results.entries()).map(([url, v]) => ({
      url,
      name: v.name,
      avatarUrl: v.avatarUrl,
    }));
    let updated = 0;
    let totalWithUrl = 0;
    const BATCH = 200;
    for (let i = 0; i < items.length; i += BATCH) {
      const slice = items.slice(i, i + BATCH);
      try {
        const r = await fetch(`${INBOXPRO_URL}/api/profile-capture/bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: slice }),
        });
        if (r.ok) {
          const j = await r.json();
          updated += j.updated ?? 0;
          if (typeof j.totalWithUrl === 'number') totalWithUrl = j.totalWithUrl;
        }
      } catch (e) {}
    }

    fetch(`${INBOXPRO_URL}/api/sync-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        src: 'harvest-button',
        ev: 'harvest.fromTab',
        collected: items.length,
        updated,
        rounds,
      }),
    }).catch(() => {});

    const totalNote = totalWithUrl > 0 ? ` · ${totalWithUrl} contacts have URLs` : '';
    setState('done', `+${updated} new matches`, `${items.length} harvested${totalNote}`);
    btn.disabled = false;
    running = false;
    setTimeout(() => {
      if (running) return;
      setState('idle', 'Scroll & harvest connections', '');
    }, 10000);
  }

  btn.addEventListener('click', run);
})();
