// LinkedIn inbox sync — API-driven, triggered from the LinkedIn messaging page.
// Shows a floating card identical in style to the SN sync button.
// Calls linkedInInitialSyncApi() in the background service worker and polls
// localhost:3030 for live conversation count progress.

(() => {
  if (window.__inboxproLiSyncBtn) return;
  window.__inboxproLiSyncBtn = true;

  const INBOXPRO_URL = 'http://localhost:3030';

  // Only show on messaging pages
  function isMessagingPath() {
    return /^\/(messaging|in\/[^/]+\/overlay\/messaging|mynetwork)/.test(location.pathname)
      || location.pathname === '/';
  }

  // ── Styles (mirrors sn-sync-button) ───────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @keyframes inboxpro-li-fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes inboxpro-li-pulse { 0%,100% { box-shadow: 0 8px 24px rgba(37,99,235,.24), 0 0 0 0 rgba(37,99,235,.30); } 50% { box-shadow: 0 8px 24px rgba(37,99,235,.18), 0 0 0 6px rgba(37,99,235,0); } }
    @keyframes inboxpro-li-spin { to { transform: rotate(360deg); } }
    #inboxpro-li-card {
      position: fixed; bottom: 24px; right: 24px; z-index: 99999;
      background: #fff; color: #18181B;
      border: 1px solid #E5E5E5; border-radius: 14px;
      padding: 12px 14px; min-width: 280px; max-width: 340px;
      box-shadow: 0 12px 28px rgba(0,0,0,.12), 0 2px 6px rgba(0,0,0,.06);
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      font-size: 13px;
      animation: inboxpro-li-fade-in 280ms cubic-bezier(.25,1,.5,1);
      -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      #inboxpro-li-card { background: #161616; color: #FAFAFA; border-color: #262626; }
      .inboxpro-li-progress { color: #A1A1A1 !important; }
      .inboxpro-li-phase { color: #71717A !important; }
      .inboxpro-li-close { color: #71717A !important; }
      .inboxpro-li-close:hover { background: #1E1E1E !important; color: #FAFAFA !important; }
    }
    .inboxpro-li-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .inboxpro-li-tile {
      width: 28px; height: 28px; border-radius: 8px;
      background: rgba(37,99,235,.10); color: #1D4ED8;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; font-weight: 700; font-size: 13px;
    }
    .inboxpro-li-title { flex: 1; font-weight: 600; font-size: 13px; }
    .inboxpro-li-close {
      background: none; border: none; cursor: pointer; padding: 4px;
      border-radius: 6px; color: #A1A1AA;
      display: flex; align-items: center; justify-content: center;
      transition: all 140ms cubic-bezier(.25,1,.5,1);
    }
    .inboxpro-li-close:hover { background: #F4F4F5; color: #18181B; }
    .inboxpro-li-btn {
      width: 100%; padding: 8px 12px; background: #1D4ED8; color: white;
      border: none; border-radius: 8px; font-size: 12.5px; font-weight: 600;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      gap: 6px; transition: all 160ms cubic-bezier(.25,1,.5,1);
      font-family: inherit;
    }
    .inboxpro-li-btn:hover:not(:disabled) { background: #2563EB; transform: translateY(-1px); }
    .inboxpro-li-btn:active:not(:disabled) { transform: scale(.98); }
    .inboxpro-li-btn:disabled { cursor: not-allowed; opacity: .85; }
    .inboxpro-li-btn--running { animation: inboxpro-li-pulse 1.8s ease-in-out infinite; }
    .inboxpro-li-btn--done { background: #16A34A; }
    .inboxpro-li-phase {
      margin-top: 8px; font-size: 11.5px; font-weight: 500; color: #52525B;
      letter-spacing: -.005em;
    }
    .inboxpro-li-progress {
      margin-top: 2px; font-size: 11px; color: #71717A;
      font-family: ui-monospace, SFMono-Regular, monospace;
      min-height: 14px;
    }
    .inboxpro-li-spin { display: inline-flex; animation: inboxpro-li-spin .9s linear infinite; }
  `;
  document.head.appendChild(style);

  const iconDownload = `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
  const iconSpin = `<span class="inboxpro-li-spin"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span>`;
  const iconCheck = `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

  function mountCard() {
    if (document.getElementById('inboxpro-li-card')) return;
    const card = document.createElement('div');
    card.id = 'inboxpro-li-card';
    card.innerHTML = `
      <div class="inboxpro-li-header">
        <div class="inboxpro-li-tile">i</div>
        <div class="inboxpro-li-title">InboxPro · LinkedIn sync</div>
        <button class="inboxpro-li-close" id="inboxpro-li-close" title="Hide" aria-label="Hide">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <button class="inboxpro-li-btn" id="inboxpro-li-btn">
        <span id="inboxpro-li-btn-icon">${iconDownload}</span>
        <span id="inboxpro-li-btn-label">Sync this LinkedIn inbox</span>
      </button>
      <div class="inboxpro-li-phase" id="inboxpro-li-phase"></div>
      <div class="inboxpro-li-progress" id="inboxpro-li-progress"></div>
    `;
    document.body.appendChild(card);

    const btn = document.getElementById('inboxpro-li-btn');
    const btnLabel = document.getElementById('inboxpro-li-btn-label');
    const btnIcon = document.getElementById('inboxpro-li-btn-icon');
    const phaseEl = document.getElementById('inboxpro-li-phase');
    const progEl = document.getElementById('inboxpro-li-progress');
    const closeEl = document.getElementById('inboxpro-li-close');

    let running = false;
    let pollInterval = null;

    closeEl.addEventListener('click', () => { if (!running) card.style.display = 'none'; });

    function setUi(state, label, phase, progress) {
      btn.className = 'inboxpro-li-btn' +
        (state === 'running' ? ' inboxpro-li-btn--running' :
         state === 'done'    ? ' inboxpro-li-btn--done' : '');
      btnIcon.innerHTML = state === 'running' ? iconSpin : state === 'done' ? iconCheck : iconDownload;
      btnLabel.textContent = label;
      phaseEl.textContent = phase || '';
      progEl.textContent = progress || '';
    }

    // Poll localhost:3030 for conversation count to show live progress
    function startProgressPoll() {
      let lastCount = 0;
      pollInterval = setInterval(async () => {
        try {
          const r = await fetch(`${INBOXPRO_URL}/api/conversations?limit=1&countOnly=true`);
          if (!r.ok) return;
          const data = await r.json();
          const count = data.total ?? data.count ?? null;
          if (count !== null && count !== lastCount) {
            lastCount = count;
            progEl.textContent = `${count} conversations loaded`;
          }
        } catch {}
      }, 2000);
    }

    function stopProgressPoll() {
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    }

    btn.addEventListener('click', () => {
      if (running) return;
      running = true;
      btn.disabled = true;

      setUi('running', 'Syncing…', 'Pulling LinkedIn inbox via API', '');
      startProgressPoll();

      chrome.runtime.sendMessage(
        { action: 'liInitialSyncApi', deepFetch: true },
        (response) => {
          stopProgressPoll();
          if (chrome.runtime.lastError || !response?.ok) {
            const reason = response?.reason ?? chrome.runtime.lastError?.message ?? 'Unknown error';
            setUi('idle', 'Retry sync', 'Error — ' + reason, '');
            btn.disabled = false;
            running = false;
            return;
          }
          setUi('done', 'Sync complete', '', `${response.convs ?? 0} conversations · ${response.msgs ?? 0} messages`);
        },
      );
    });
  }

  // Mount immediately if on a messaging path, otherwise wait for navigation
  if (isMessagingPath()) {
    if (document.body) mountCard();
    else document.addEventListener('DOMContentLoaded', mountCard);
  }

  // LinkedIn is a SPA — re-check on navigation
  let lastPath = location.pathname;
  const navObserver = new MutationObserver(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (isMessagingPath()) mountCard();
    }
  });
  navObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
