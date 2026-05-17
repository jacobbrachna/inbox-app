// Profile-page capture. Runs on linkedin.com/in/* pages.
// When LinkedIn finishes rendering the profile, we read the meta tags (most
// stable surface — survives React UI shuffles) and post the data to InboxPro
// for participant matching. Zero LinkedIn API calls — we read what the
// browser already rendered.
//
// Spam-filter posture: this triggers only when the user themselves visits a
// profile in their normal session. Indistinguishable from regular browsing.

(() => {
  const INBOXPRO_URL = 'http://localhost:3030';
  let sent = false;
  let observer = null;
  let startedAt = 0;
  let banner = null;
  let progressTimer = null;
  const CAPTURE_BUDGET_S = 18;

  // ── In-page progress card (LinkedIn-native styling) ────────────────────
  // Designed to blend with LinkedIn's UI: LinkedIn blue (#0A66C2), 8px card
  // radius, weight 600 type, native-feeling shadow. IP tile preserved so
  // user knows it's our extension, not a LinkedIn feature.
  function setupBanner() {
    try {
      const style = document.createElement('style');
      style.textContent = `
        @keyframes inboxpro-capture-in { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: translateY(0); } }
        @keyframes inboxpro-capture-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(10,102,194,.32); } 50% { box-shadow: 0 0 0 6px rgba(10,102,194,0); } }
        #inboxpro-capture-banner {
          position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
          background: #FFFFFF; color: rgba(0,0,0,.9);
          border-radius: 8px;
          padding: 14px 16px; min-width: 300px; max-width: 360px;
          box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.15);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', system-ui, sans-serif;
          font-size: 14px;
          animation: inboxpro-capture-in 240ms cubic-bezier(.25,1,.5,1);
          -webkit-font-smoothing: antialiased;
        }
        @media (prefers-color-scheme: dark) {
          #inboxpro-capture-banner { background: #1B1F23; color: rgba(255,255,255,.9); box-shadow: 0 0 0 1px rgba(255,255,255,.1), 0 4px 12px rgba(0,0,0,.5); }
          #inboxpro-capture-banner .inboxpro-cap-phase { color: rgba(255,255,255,.6) !important; }
        }
        #inboxpro-capture-banner .inboxpro-cap-header { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
        #inboxpro-capture-banner .inboxpro-cap-tile {
          width: 32px; height: 32px; border-radius: 50%;
          background: #0A66C2; color: #FFFFFF;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0; font-weight: 700; font-size: 12px; letter-spacing: 0.3px;
          animation: inboxpro-capture-pulse 1.8s ease-in-out infinite;
        }
        #inboxpro-capture-banner .inboxpro-cap-tile.done { animation: none; background: #057642; }
        #inboxpro-capture-banner .inboxpro-cap-title { flex: 1; font-weight: 600; font-size: 14px; line-height: 1.3; }
        #inboxpro-capture-banner .inboxpro-cap-phase {
          font-size: 12px; color: rgba(0,0,0,.6); margin-top: 2px; font-weight: 400;
        }
        #inboxpro-capture-banner .inboxpro-cap-bar {
          height: 3px; background: rgba(10,102,194,.12); border-radius: 999px; overflow: hidden;
        }
        #inboxpro-capture-banner .inboxpro-cap-fill {
          height: 100%; background: #0A66C2; border-radius: 999px;
          transition: width 0.4s cubic-bezier(.25,1,.5,1); width: 0%;
        }
        #inboxpro-capture-banner .inboxpro-cap-fill.done { background: #057642; }
      `;
      document.head?.appendChild(style);

      const el = document.createElement('div');
      el.id = 'inboxpro-capture-banner';
      el.innerHTML = `
        <div class="inboxpro-cap-header">
          <div class="inboxpro-cap-tile">IP</div>
          <div>
            <div class="inboxpro-cap-title">Capturing profile</div>
            <div class="inboxpro-cap-phase">This tab will close automatically · <span class="inboxpro-cap-time">0s</span></div>
          </div>
        </div>
        <div class="inboxpro-cap-bar"><div class="inboxpro-cap-fill"></div></div>
      `;
      document.documentElement.appendChild(el);
      banner = el;
      progressTimer = setInterval(() => {
        if (!banner) return;
        const elapsedS = (Date.now() - startedAt) / 1000;
        const pct = Math.min(100, (elapsedS / CAPTURE_BUDGET_S) * 100);
        const fill = banner.querySelector('.inboxpro-cap-fill');
        const time = banner.querySelector('.inboxpro-cap-time');
        if (fill && !fill.classList.contains('done')) fill.style.width = `${pct}%`;
        if (time) time.textContent = `${Math.floor(elapsedS)}s`;
      }, 250);
    } catch {}
  }
  function removeBanner() {
    try { clearInterval(progressTimer); } catch {}
    try { banner?.remove(); } catch {}
  }

  function extract() {
    const meta = (prop) => {
      const el = document.querySelector(`meta[property="${prop}"]`)
        || document.querySelector(`meta[name="${prop}"]`);
      return el?.getAttribute('content') ?? null;
    };

    const ogUrl = meta('og:url') || location.href;
    const ogTitle = meta('og:title') || document.title;
    if (!ogTitle) return null;

    const stripped = ogTitle.replace(/\s*[-|]\s*LinkedIn.*$/i, '');
    let name = stripped;
    let headline = '';
    const sep = stripped.match(/^(.*?)\s+[-—]\s+(.+)$/);
    if (sep) {
      name = sep[1].trim();
      headline = sep[2].trim();
    }

    let company = null;
    let role = null;
    let locationName = null;

    // ── Best signal: schema.org JSON-LD that LinkedIn embeds for SEO.
    // It's stable across LinkedIn redesigns because Google relies on it.
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const ld = JSON.parse(s.textContent || '');
        const candidates = Array.isArray(ld?.['@graph']) ? ld['@graph'] : [ld];
        const person = candidates.find((c) =>
          c?.['@type'] === 'Person' ||
          (Array.isArray(c?.['@type']) && c['@type'].includes('Person')),
        );
        if (!person) continue;
        if (typeof person.jobTitle === 'string') role = person.jobTitle;
        else if (Array.isArray(person.jobTitle) && typeof person.jobTitle[0] === 'string') role = person.jobTitle[0];
        const works = Array.isArray(person.worksFor) ? person.worksFor[0] : person.worksFor;
        if (typeof works?.name === 'string') company = works.name;
        const addr = person.address;
        if (typeof addr?.addressLocality === 'string') {
          const region = addr.addressRegion ? `, ${addr.addressRegion}` : '';
          locationName = `${addr.addressLocality}${region}`;
        } else if (typeof addr?.name === 'string') {
          locationName = addr.name;
        }
        if (role || company) break;
      } catch {}
    }

    // ── Fallback 1: parse the headline "<role> at <company>" pattern.
    if (!company && headline) {
      const atMatch = headline.match(/^(.+?)\s+at\s+(.+)$/i);
      if (atMatch) {
        if (!role) role = atMatch[1].trim();
        company = atMatch[2].trim();
      } else if (!role) {
        role = headline;
      }
    }

    // ── Fallback 2: DOM selectors — fragile but useful when JSON-LD is missing.
    if (!locationName) {
      const locEl =
        document.querySelector('.text-body-small.inline.t-black--light.break-words') ||
        document.querySelector('[data-test-location]');
      if (locEl) locationName = locEl.textContent?.trim() ?? null;
    }

    // ── Rich fields via DOM scraping. LinkedIn duplicates visible text and
    // screen-reader text in the same node, so we strip the obvious patterns.
    // Each scrape wrapped so a single broken selector can't kill the basic capture.
    const about = safe(scrapeAbout);
    const prevRoles = safeArr(scrapeExperience);
    const education = safeArr(scrapeEducation);
    // Posts come from a different path — document.body.innerText after
    // LinkedIn has rendered the Activity section into the DOM. More reliable
    // than parsing SDUI/RSC network responses (which often arrive empty).
    const recentPosts = safeArr(scrapeActivityFromInnerText);

    return {
      url: ogUrl,
      name,
      headline: headline || null,
      role,
      company,
      location: locationName,
      about: about || null,
      prevRoles: prevRoles.length > 0 ? prevRoles : null,
      education: education.length > 0 ? education : null,
      recentPosts: recentPosts.length > 0 ? recentPosts : null,
    };
  }

  function safe(fn) {
    try { return fn(); } catch (e) {
      try {
        fetch(`${INBOXPRO_URL}/api/sync-log`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ src: 'profileCapture', ev: 'capture.scrapeErr', fn: fn.name, err: e?.message }),
        }).catch(() => {});
      } catch {}
      return null;
    }
  }
  function safeArr(fn) {
    const v = safe(fn);
    return Array.isArray(v) ? v : [];
  }

  // LinkedIn's a11y pattern renders the same text twice in adjacent spans
  // (one aria-hidden="true", one visually-hidden). `textContent` glues them
  // into "Foo BarFoo Bar". Strip the duplicate by walking aria-hidden spans
  // only when both forms are present; else fall back to the raw text.
  function cleanText(node) {
    if (!node) return '';
    const arias = node.querySelectorAll('span[aria-hidden="true"]');
    if (arias.length > 0) {
      return Array.from(arias).map((s) => s.textContent?.trim() || '').filter(Boolean).join(' · ').trim();
    }
    return (node.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Find the <section> whose heading text matches one of `labels`. Modern
  // LinkedIn marks each profile section with a heading anchor (`#about`,
  // `#experience`, `#education`, etc.) — that's the most stable signal.
  function findSection(...labels) {
    for (const label of labels) {
      const lc = label.toLowerCase();
      // Strategy 1: anchor div with id matching the label
      const anchor = document.getElementById(lc);
      if (anchor) {
        const section = anchor.closest('section');
        if (section) return section;
      }
      // Strategy 2: heading text match
      const headings = document.querySelectorAll('section h2, section h3');
      for (const h of headings) {
        const txt = (h.textContent || '').trim().toLowerCase();
        if (txt === lc || txt.startsWith(lc + ' ')) {
          const section = h.closest('section');
          if (section) return section;
        }
      }
    }
    return null;
  }

  function scrapeAbout() {
    const section = findSection('about');
    if (!section) return null;
    // The About text is the largest contiguous block of text inside this
    // section after the heading. LinkedIn often wraps it in
    // .display-flex .full-width or .pv-shared-text-with-see-more.
    const text = section.querySelector('.display-flex.full-width span[aria-hidden="true"]')
      || section.querySelector('.pv-shared-text-with-see-more span[aria-hidden="true"]')
      || section.querySelector('span[aria-hidden="true"]');
    if (!text) return null;
    const raw = (text.textContent || '').trim();
    if (raw.length < 30) return null; // probably a section label, not the body
    return raw.slice(0, 4000);
  }

  function scrapeExperience() {
    const section = findSection('experience');
    if (!section) return [];
    const items = section.querySelectorAll('ul > li');
    const out = [];
    for (const li of items) {
      const lines = Array.from(li.querySelectorAll('span[aria-hidden="true"]'))
        .map((s) => (s.textContent || '').trim())
        .filter(Boolean);
      // Dedupe consecutive duplicates (a11y duplication)
      const dedup = lines.filter((l, i) => l !== lines[i - 1]);
      if (dedup.length === 0) continue;
      // Heuristic: line 1 = role title, line 2 = company (+ employment type),
      // line 3 = date range, line 4 = location/extras
      const role = dedup[0] || null;
      const company = dedup[1] ? dedup[1].split(' · ')[0].trim() : null;
      const dateLine = dedup.find((l) => /\d{4}/.test(l) && /(present|\d{4})/i.test(l));
      let from = null, to = null;
      if (dateLine) {
        const m = dateLine.match(/^(.*?)\s*[-–—]\s*(.*?)(\s*[·•].*)?$/);
        if (m) {
          from = (m[1] || '').trim() || null;
          to = (m[2] || '').trim().toLowerCase() === 'present' ? null : ((m[2] || '').trim() || null);
        }
      }
      if (role || company) out.push({ role, company, from, to });
      if (out.length >= 5) break;
    }
    return out;
  }

  function scrapeEducation() {
    const section = findSection('education');
    if (!section) return [];
    const items = section.querySelectorAll('ul > li');
    const out = [];
    for (const li of items) {
      const lines = Array.from(li.querySelectorAll('span[aria-hidden="true"]'))
        .map((s) => (s.textContent || '').trim())
        .filter(Boolean);
      const dedup = lines.filter((l, i) => l !== lines[i - 1]);
      if (dedup.length === 0) continue;
      const school = dedup[0] || null;
      const degree = dedup[1] || null;
      const dateLine = dedup.find((l) => /\d{4}/.test(l));
      let from = null, to = null;
      if (dateLine) {
        const m = dateLine.match(/^(.*?)\s*[-–—]\s*(.*?)$/);
        if (m) {
          from = (m[1] || '').trim() || null;
          to = (m[2] || '').trim() || null;
        } else {
          to = dateLine;
        }
      }
      if (school) out.push({ school, degree, from, to });
      if (out.length >= 5) break;
    }
    return out;
  }

  // DOM-innerText-based activity scrape. Reads what's visually in the DOM
  // after LinkedIn finishes injecting the Activity feed, then slices between
  // the "Activity" header and the next major section, then splits into post
  // entries on time-ago markers ("1 week ago", "3 weeks ago", etc.).
  //
  // This works regardless of LinkedIn's class names or component structure
  // because innerText gives us the same content the user sees.
  function scrapeActivityFromInnerText() {
    const text = document.body?.innerText;
    if (!text) return [];

    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    let startIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === 'Activity') { startIdx = i; break; }
    }
    if (startIdx === -1) return [];

    const SECTION_BOUNDARY = new Set([
      'Featured', 'Experience', 'Education', 'Licenses & certifications',
      'Skills', 'Recommendations', 'Publications', 'Projects', 'Honors & awards',
      'Languages', 'Volunteer experience', 'Interests', 'Courses',
      'Test scores', 'Patents', 'People also viewed', 'People you may know',
    ]);
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (SECTION_BOUNDARY.has(lines[i])) { endIdx = i; break; }
    }

    const slice = lines.slice(startIdx + 1, endIdx);

    // LinkedIn uses abbreviated time markers: "1w •", "3mo •", "2d •", "5h •".
    // These appear BEFORE the post body (after the author info), so we walk
    // forward and start a new entry on each marker.
    const TIME_MARKER = /^(\d+)\s*(m|h|d|w|mo|y)\s*[•·]/i;

    // Convert "1w •" / "3mo •" / "2d •" / "5h •" to an approximate ISO date.
    // Best-effort — LinkedIn doesn't give us exact timestamps.
    function markerToISO(marker) {
      const m = marker.match(/^(\d+)\s*(m|h|d|w|mo|y)/i);
      if (!m) return null;
      const n = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      const now = Date.now();
      const ms = unit === 'm' ? n * 60_000
        : unit === 'h' ? n * 3_600_000
        : unit === 'd' ? n * 86_400_000
        : unit === 'w' ? n * 7 * 86_400_000
        : unit === 'mo' ? n * 30 * 86_400_000
        : unit === 'y' ? n * 365 * 86_400_000
        : 0;
      return new Date(now - ms).toISOString();
    }
    const REACTION_LINE = /^\d[\d,]*$/;
    const ATTRIBUTION = /^(.+ reposted this|.+ liked this|.+ commented on this|.+ reposted by)$/i;
    const SKIP_LINE = (l) =>
      REACTION_LINE.test(l) ||
      ATTRIBUTION.test(l) ||
      /^…\s*more$/i.test(l) ||
      /^https?:\/\//.test(l) ||
      /^•\s+\d+(st|nd|rd|th)$/i.test(l) || // connection degree like "• 2nd"
      /^\s*•\s*$/.test(l) ||
      l.length < 8;

    const posts = [];
    let inBody = false;
    let currentBody = [];
    let currentMarker = null;
    let lastAttribution = null;

    function commit() {
      if (currentBody.length === 0 || !currentMarker) return;
      const body = currentBody.join(' ').replace(/\s+/g, ' ').slice(0, 600);
      if (body.length >= 20) {
        const isRepost = !!lastAttribution && /reposted this/i.test(lastAttribution);
        posts.push({
          text: body,
          url: null,
          postedAt: markerToISO(currentMarker), // ISO date so consumers can render with date-fns
          kind: isRepost ? 'reshare' : 'post',
        });
      }
    }

    for (const line of slice) {
      // Track latest attribution so we know if the upcoming post is a repost
      if (ATTRIBUTION.test(line)) {
        lastAttribution = line;
        continue;
      }
      const tm = line.match(TIME_MARKER);
      if (tm) {
        // Commit previous post, start new one
        commit();
        currentMarker = line;
        currentBody = [];
        inBody = true;
        if (posts.length >= 5) break;
        continue;
      }
      if (!inBody) continue;
      if (SKIP_LINE(line)) continue;
      currentBody.push(line);
    }
    commit();

    return posts;
  }

  function scrapeActivity() {
    // The "Activity" section on a profile shows the user's recent posts/reshares.
    const section = findSection('activity', 'recent_activity');
    if (!section) return [];
    const items = section.querySelectorAll('ul > li');
    const out = [];
    for (const li of items) {
      // Post text is in the post-body region; date is in a metadata span.
      const textNode = li.querySelector('.update-components-text span[aria-hidden="true"]')
        || li.querySelector('span[aria-hidden="true"]');
      const text = textNode ? (textNode.textContent || '').trim() : null;
      if (!text || text.length < 5) continue;
      // Try to find a permalink — anchor to the post detail
      const link = li.querySelector('a[href*="/feed/update/"]') || li.querySelector('a[href*="/posts/"]');
      const url = link ? new URL(link.getAttribute('href') || '', location.origin).href : null;
      // Date is often a relative string like "2d • Edited"; we don't parse it precisely
      const dateText = li.querySelector('.update-components-actor__sub-description span[aria-hidden="true"]')
        || li.querySelector('time')
        || null;
      const postedAt = dateText ? (dateText.getAttribute('datetime') || dateText.textContent || '').trim() : null;
      out.push({ url, text: text.slice(0, 600), postedAt: postedAt || null, kind: 'post' });
      if (out.length >= 5) break;
    }
    return out;
  }

  function send(data) {
    if (sent) return;
    sent = true;
    fetch(`${INBOXPRO_URL}/api/profile-capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(() => {});
    // Diagnostic — what did we actually scrape? Tracks section finder hits.
    // Includes a slice of innerText around "Activity" so we can debug why
    // posts may have returned 0 entries even when LinkedIn shows them visually.
    const innerText = document.body?.innerText ?? '';
    const activityIdx = innerText.indexOf('Activity');
    const activitySlice = activityIdx >= 0
      ? innerText.slice(activityIdx, activityIdx + 1200)
      : null;
    const diag = {
      url: data.url,
      name: data.name,
      hasCompany: !!data.company,
      hasRole: !!data.role,
      hasLocation: !!data.location,
      aboutLen: data.about ? data.about.length : 0,
      prevRolesCount: Array.isArray(data.prevRoles) ? data.prevRoles.length : 0,
      educationCount: Array.isArray(data.education) ? data.education.length : 0,
      postsCount: Array.isArray(data.recentPosts) ? data.recentPosts.length : 0,
      sectionCount: document.querySelectorAll('section').length,
      activityIdx,
      activitySlice,
    };
    fetch(`${INBOXPRO_URL}/api/sync-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: 'profileCapture', ev: 'capture.sent', ...diag }),
    }).catch(() => {});
    // Quick "Captured ✓" confirmation before the tab closes.
    if (banner) {
      const fields = [
        data.about ? 'About' : null,
        (data.prevRoles?.length ?? 0) > 0 ? `${data.prevRoles.length} role${data.prevRoles.length === 1 ? '' : 's'}` : null,
        (data.recentPosts?.length ?? 0) > 0 ? `${data.recentPosts.length} post${data.recentPosts.length === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join(' · ') || 'basic info';
      banner.innerHTML = `
        <div class="inboxpro-cap-header">
          <div class="inboxpro-cap-tile done">✓</div>
          <div>
            <div class="inboxpro-cap-title">Imported to InboxPro</div>
            <div class="inboxpro-cap-phase">${fields} · closing tab</div>
          </div>
        </div>
        <div class="inboxpro-cap-bar"><div class="inboxpro-cap-fill done" style="width:100%"></div></div>
      `;
    }

    // Silent mode (messageable contact, no banner) → small bottom-right
    // toast so the user knows we refreshed their data. Auto-fades.
    if (!banner) showSilentToast(data);
    // Notify background so it can close the tab early and unblock the UI.
    // 800ms delay so the user sees the "Captured ✓" confirmation flash.
    setTimeout(() => {
      try {
        chrome.runtime.sendMessage({ action: 'captureComplete' });
      } catch {
        // extension context invalidated; tab will close on background timeout
      }
    }, 800);
  }

  function tryCapture() {
    if (sent) return;
    const data = extract();
    if (!data || !data.name) return;
    // Send once we have at least name AND (rich field OR 6s elapsed).
    // Earlier sends ran before LinkedIn rendered About/Experience.
    const hasRich = !!(data.about || (data.prevRoles && data.prevRoles.length) || (data.education && data.education.length) || (data.recentPosts && data.recentPosts.length));
    const elapsed = Date.now() - startedAt;
    if (!hasRich && elapsed < 6_000) return;
    send(data);
    if (observer) { observer.disconnect(); observer = null; }
  }

  // Active-capture flow: banner + retries + DOM observer. Triggered either
  // by an app-initiated tab on load, or by the user clicking the floating
  // "Import to InboxPro" button on a natural visit.
  function startCapture({ silent = false } = {}) {
    if (sent) return;
    startedAt = Date.now();
    if (!silent) setupBanner();

    // Deterministic retry schedule. Don't rely on MutationObserver because
    // LinkedIn's React tree goes idle once rendered, which means no callbacks
    // fire and the conditional send (rich-OR-6s-elapsed) is never invoked.
    // Hidden tabs close around T=15s, so all attempts must complete before that.
    const RETRY_AT_MS = [1500, 4000, 6500, 9000, 12000];
    for (const ms of RETRY_AT_MS) setTimeout(tryCapture, ms);

    // Final-shot extract + send at 13s — still ahead of the bg tab-close at ~15s.
    setTimeout(() => {
      if (sent) return;
      const data = extract();
      if (data && data.name) send(data);
    }, 13_000);

    // MutationObserver kept as a bonus signal in case the page renders late.
    observer = new MutationObserver(() => {
      if (sent) {
        try { observer.disconnect(); } catch {}
        observer = null;
        return;
      }
      tryCapture();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Floating "Import to InboxPro" pill — LinkedIn-native styling. Looks
  // like a LinkedIn primary action button: filled LinkedIn blue, pill
  // shape, weight 600, native shadow. IP avatar tile preserves brand identity.
  function showFloatingButton() {
    try {
      if (document.getElementById('inboxpro-floating-btn')) return;
      if (!document.getElementById('inboxpro-floating-btn-style')) {
        const style = document.createElement('style');
        style.id = 'inboxpro-floating-btn-style';
        style.textContent = `
          @keyframes inboxpro-fb-in { from { opacity:0; transform: translateY(-50%) translateX(-8px); } to { opacity:1; transform: translateY(-50%) translateX(0); } }
          #inboxpro-floating-btn {
            position: fixed; left: 16px; top: 50%; transform: translateY(-50%);
            z-index: 2147483647;
            background: #0A66C2; color: #FFFFFF;
            border: 0; border-radius: 24px;
            padding: 8px 16px 8px 8px;
            box-shadow: 0 0 0 1px rgba(0,0,0,.04), 0 4px 12px rgba(10,102,194,.32);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', system-ui, sans-serif;
            font-size: 14px; font-weight: 600;
            cursor: pointer;
            display: inline-flex; align-items: center; gap: 10px;
            animation: inboxpro-fb-in 220ms cubic-bezier(.25,1,.5,1);
            transition: background 120ms cubic-bezier(.25,1,.5,1), box-shadow 120ms, transform 120ms;
            -webkit-font-smoothing: antialiased;
          }
          #inboxpro-floating-btn:hover {
            background: #004182;
            box-shadow: 0 0 0 1px rgba(0,0,0,.04), 0 6px 16px rgba(10,102,194,.40);
            transform: translateY(-50%) scale(1.02);
          }
          #inboxpro-floating-btn:active {
            transform: translateY(-50%) scale(.98);
          }
          #inboxpro-floating-btn .inboxpro-fb-tile {
            width: 28px; height: 28px; border-radius: 50%;
            background: #FFFFFF; color: #0A66C2;
            display: flex; align-items: center; justify-content: center;
            font-weight: 700; font-size: 11px; letter-spacing: 0.3px;
            flex-shrink: 0;
          }
        `;
        document.head?.appendChild(style);
      }

      const btn = document.createElement('button');
      btn.id = 'inboxpro-floating-btn';
      btn.type = 'button';
      btn.innerHTML = `
        <span class="inboxpro-fb-tile">IP</span>
        <span>Import to InboxPro</span>
      `;
      btn.addEventListener('click', () => {
        try { btn.remove(); } catch {}
        startCapture({ silent: false });
      });
      document.documentElement.appendChild(btn);
    } catch {}
  }

  // Tiny bottom-right toast for silent refreshes — confirms to the user
  // that InboxPro just updated their data without the more visible banner.
  // Auto-dismisses; can stack if user navigates between profiles quickly.
  function showSilentToast(data) {
    try {
      if (!document.getElementById('inboxpro-silent-toast-style')) {
        const style = document.createElement('style');
        style.id = 'inboxpro-silent-toast-style';
        style.textContent = `
          @keyframes inboxpro-toast-in { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: translateY(0); } }
          @keyframes inboxpro-toast-out { to { opacity:0; transform: translateY(8px); } }
          .inboxpro-silent-toast {
            position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
            background: #FFFFFF; color: rgba(0,0,0,.9);
            border-radius: 8px;
            padding: 10px 14px;
            box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.15);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', system-ui, sans-serif;
            font-size: 13px; font-weight: 500;
            display: inline-flex; align-items: center; gap: 10px;
            animation: inboxpro-toast-in 200ms cubic-bezier(.25,1,.5,1);
          }
          .inboxpro-silent-toast.leaving { animation: inboxpro-toast-out 240ms cubic-bezier(.55,0,.65,.2) forwards; }
          @media (prefers-color-scheme: dark) {
            .inboxpro-silent-toast { background: #1B1F23; color: rgba(255,255,255,.9); box-shadow: 0 0 0 1px rgba(255,255,255,.1), 0 4px 12px rgba(0,0,0,.5); }
          }
          .inboxpro-silent-toast .inboxpro-toast-dot {
            width: 16px; height: 16px; border-radius: 50%;
            background: #057642; color: #FFFFFF;
            display: flex; align-items: center; justify-content: center;
            font-size: 10px; font-weight: 700; flex-shrink: 0;
          }
        `;
        document.head?.appendChild(style);
      }
      const toast = document.createElement('div');
      toast.className = 'inboxpro-silent-toast';
      const fieldList = [
        data?.about ? 'About' : null,
        (data?.prevRoles?.length ?? 0) > 0 ? `${data.prevRoles.length} role${data.prevRoles.length === 1 ? '' : 's'}` : null,
        (data?.recentPosts?.length ?? 0) > 0 ? `${data.recentPosts.length} post${data.recentPosts.length === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join(' · ');
      toast.innerHTML = `
        <span class="inboxpro-toast-dot">✓</span>
        <span>Refreshed by InboxPro${fieldList ? ` · <span style="opacity:.6">${fieldList}</span>` : ''}</span>
      `;
      document.documentElement.appendChild(toast);
      setTimeout(() => { toast.classList.add('leaving'); }, 2500);
      setTimeout(() => { try { toast.remove(); } catch {} }, 2900);
    } catch {}
  }

  // Bootstrap: decide what to do based on tab origin + contact status.
  //   1. App-initiated tab (Refresh button etc.) → full capture, banner on.
  //   2. Natural visit, contact has a conversation → silent refresh, no UI.
  //   3. Natural visit, stranger → floating button, no capture until clicked.
  async function bootstrap() {
    const slug = location.pathname.match(/^\/in\/([^/?#]+)/)?.[1] ?? '';

    let appInitiated = false;
    try {
      const resp = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ action: 'is-app-initiated' }, (r) => resolve(r));
        } catch { resolve(null); }
      });
      appInitiated = !!resp?.initiated;
    } catch {}

    if (appInitiated) {
      startCapture({ silent: false });
      return;
    }

    let messageable = false;
    if (slug) {
      try {
        const r = await fetch(`${INBOXPRO_URL}/api/contacts/by-slug/${encodeURIComponent(slug)}/status`);
        if (r.ok) {
          const j = await r.json();
          messageable = !!j.messageable;
        }
      } catch {}
    }

    if (messageable) startCapture({ silent: true });
    else showFloatingButton();
  }

  // Reset between SPA navigations so each new profile gets a fresh bootstrap.
  // LinkedIn uses pushState routing between /in/<slug> pages, which means
  // content scripts don't re-execute. Without this, the floating button
  // from one profile lingers on the next, or never appears at all.
  function teardown() {
    sent = false;
    if (observer) { try { observer.disconnect(); } catch {} observer = null; }
    removeBanner();
    try { document.getElementById('inboxpro-floating-btn')?.remove(); } catch {}
  }

  let lastPath = location.pathname;
  function onPossibleUrlChange() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (!/^\/in\/[^/]+/.test(location.pathname)) {
      teardown();
      return;
    }
    teardown();
    bootstrap();
  }

  // We're in the ISOLATED world; LinkedIn's React calls history.pushState
  // in the MAIN world, so patching our own history doesn't see those calls.
  // popstate fires for back/forward in both worlds, so we hook that — and
  // poll for forward navigations triggered by clicks/links.
  window.addEventListener('popstate', () => setTimeout(onPossibleUrlChange, 0));
  setInterval(onPossibleUrlChange, 800);

  bootstrap();
})();
