// Profile-page capture. Runs on linkedin.com/in/* pages.
// When LinkedIn finishes rendering the profile, we read the meta tags (most
// stable surface — survives React UI shuffles) and post the data to Relay
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
  const CAPTURE_BUDGET_S = 25;

  // ── In-page progress card (LinkedIn-native styling) ────────────────────
  // Designed to blend with LinkedIn's UI: LinkedIn blue (#0A66C2), 8px card
  // radius, weight 600 type, native-feeling shadow. IP tile preserved so
  // user knows it's our extension, not a LinkedIn feature.
  function setupBanner() {
    // Compliance: no injected on-page UI. We never modify LinkedIn's DOM, so
    // their page-scan detection finds nothing. `banner` stays null and every
    // updater below guards on it, so capture proceeds invisibly.
    return;
    // eslint-disable-next-line no-unreachable
    try {
      const style = document.createElement('style');
      style.textContent = `
        @keyframes relay-capture-in { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: translateY(0); } }
        @keyframes relay-capture-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(10,102,194,.32); } 50% { box-shadow: 0 0 0 6px rgba(10,102,194,0); } }
        #relay-capture-banner {
          position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
          background: #FFFFFF; color: rgba(0,0,0,.9);
          border-radius: 8px;
          padding: 14px 16px; min-width: 300px; max-width: 360px;
          box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.15);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', system-ui, sans-serif;
          font-size: 14px;
          animation: relay-capture-in 240ms cubic-bezier(.25,1,.5,1);
          -webkit-font-smoothing: antialiased;
        }
        @media (prefers-color-scheme: dark) {
          #relay-capture-banner { background: #1B1F23; color: rgba(255,255,255,.9); box-shadow: 0 0 0 1px rgba(255,255,255,.1), 0 4px 12px rgba(0,0,0,.5); }
          #relay-capture-banner .relay-cap-phase { color: rgba(255,255,255,.6) !important; }
        }
        #relay-capture-banner .relay-cap-header { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
        #relay-capture-banner .relay-cap-tile {
          width: 32px; height: 32px; border-radius: 50%;
          background: #0A66C2; color: #FFFFFF;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0; font-weight: 700; font-size: 12px; letter-spacing: 0.3px;
          animation: relay-capture-pulse 1.8s ease-in-out infinite;
        }
        #relay-capture-banner .relay-cap-tile.done { animation: none; background: #057642; }
        #relay-capture-banner .relay-cap-title { flex: 1; font-weight: 600; font-size: 14px; line-height: 1.3; }
        #relay-capture-banner .relay-cap-phase {
          font-size: 12px; color: rgba(0,0,0,.6); margin-top: 2px; font-weight: 400;
        }
        #relay-capture-banner .relay-cap-bar {
          height: 3px; background: rgba(10,102,194,.12); border-radius: 999px; overflow: hidden;
        }
        #relay-capture-banner .relay-cap-fill {
          height: 100%; background: #0A66C2; border-radius: 999px;
          transition: width 0.4s cubic-bezier(.25,1,.5,1); width: 0%;
        }
        #relay-capture-banner .relay-cap-fill.done { background: #057642; }
      `;
      document.head?.appendChild(style);

      const el = document.createElement('div');
      el.id = 'relay-capture-banner';
      el.innerHTML = `
        <div class="relay-cap-header">
          <div class="relay-cap-tile">IP</div>
          <div>
            <div class="relay-cap-title">Capturing profile</div>
            <div class="relay-cap-phase">This tab will close automatically · <span class="relay-cap-time">0s</span></div>
          </div>
        </div>
        <div class="relay-cap-bar"><div class="relay-cap-fill"></div></div>
      `;
      document.documentElement.appendChild(el);
      banner = el;
      progressTimer = setInterval(() => {
        if (!banner) return;
        const elapsedS = (Date.now() - startedAt) / 1000;
        const pct = Math.min(100, (elapsedS / CAPTURE_BUDGET_S) * 100);
        const fill = banner.querySelector('.relay-cap-fill');
        const time = banner.querySelector('.relay-cap-time');
        if (fill && !fill.classList.contains('done')) fill.style.width = `${pct}%`;
        if (time) time.textContent = `${Math.floor(elapsedS)}s`;
      }, 250);
    } catch {}
  }
  function removeBanner() {
    try { clearInterval(progressTimer); } catch {}
    try { banner?.remove(); } catch {}
  }

  // LinkedIn occasionally serves an error/interstitial page (rate limit,
  // logged-out, or "this page isn't available") that contains none of the
  // profile sections. Detect those before scraping so we don't write the
  // generic error copy into Contact.recentPosts / About / etc.
  function looksLikeErrorPage() {
    const t = document.body?.innerText || '';
    if (!t) return true;
    // Real profile pages are thousands of chars long and contain at least
    // one of the major section labels.
    if (t.length < 800) return true;
    const ERROR_PHRASES = [
      'Check your connection',
      'This page isn’t available',
      "This page isn't available",
      'Page not found',
      'We can’t seem to find',
      "We can't seem to find",
      'Sign in to LinkedIn',
      'something went wrong',
    ];
    if (ERROR_PHRASES.some((p) => t.includes(p))) return true;
    // No common profile section headers visible → almost certainly not a
    // profile page (could be feed, login, error, etc.).
    const SECTION_HINTS = ['Experience', 'Education', 'About', 'Activity', 'Skills'];
    if (!SECTION_HINTS.some((p) => t.includes(p))) return true;
    return false;
  }

  function extract() {
    if (looksLikeErrorPage()) return null;
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
    // Each scrape wrapped so a single broken selector can't kill the basic
    // capture. Each section has a DOM-selector scrape AND an innerText
    // fallback — LinkedIn restructures their DOM regularly, but the visible
    // text order tends to stay stable. Fallback runs whenever the structured
    // scrape returns empty/null.
    const about = safe(scrapeAbout) || safe(scrapeAboutFromInnerText);
    const domExp = safeArr(scrapeExperience);
    const prevRoles = domExp.length > 0 ? domExp : safeArr(scrapeExperienceFromInnerText);
    const domEdu = safeArr(scrapeEducation);
    const education = domEdu.length > 0 ? domEdu : safeArr(scrapeEducationFromInnerText);
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

    // LinkedIn renders an inline error inside the Activity widget when it
    // can't load that section ("Check your connection..."). Without this
    // filter, those phrases get captured as if they were post bodies.
    const POST_ERROR_PHRASES = [
      'Check your connection',
      'refresh the page',
      "This page isn't available",
      'This page isn’t available',
      'No posts to show',
      'Nothing to see here',
      "doesn't have any activity",
      'has not posted anything',
    ];
    function looksLikePostError(body) {
      return POST_ERROR_PHRASES.some((p) => body.includes(p));
    }

    function commit() {
      if (currentBody.length === 0 || !currentMarker) return;
      const body = currentBody.join(' ').replace(/\s+/g, ' ').slice(0, 600);
      if (body.length < 20) return;
      if (looksLikePostError(body)) return;
      const isRepost = !!lastAttribution && /reposted this/i.test(lastAttribution);
      posts.push({
        text: body,
        url: null,
        postedAt: markerToISO(currentMarker),
        kind: isRepost ? 'reshare' : 'post',
      });
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

  // ─── innerText fallback scrapers ──────────────────────────────────────
  // Used when the structured DOM scrapers (which rely on specific
  // <section>/<span aria-hidden> selectors) return empty. innerText
  // mirrors what the user actually sees, so it survives LinkedIn DOM
  // restructures better.

  // Universe of section labels we know about — any of these terminates the
  // current section's content slice. Same set the Activity scraper uses.
  const KNOWN_SECTION_LABELS = [
    'About', 'Featured', 'Activity', 'Experience', 'Education',
    'Licenses & certifications', 'Skills', 'Recommendations',
    'Publications', 'Projects', 'Honors & awards', 'Languages',
    'Volunteer experience', 'Interests', 'Courses', 'Test scores',
    'Patents', 'People also viewed', 'People you may know',
  ];

  // Slice innerText lines between `label` and the next known section label.
  // Returns [] if `label` not found. Trims and filters blanks.
  function sliceSectionLines(label) {
    const text = document.body?.innerText;
    if (!text) return [];
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    let startIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === label) { startIdx = i; break; }
    }
    if (startIdx === -1) return [];
    const boundaries = new Set(KNOWN_SECTION_LABELS.filter((l) => l !== label));
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (boundaries.has(lines[i])) { endIdx = i; break; }
    }
    return lines.slice(startIdx + 1, endIdx);
  }

  function scrapeAboutFromInnerText() {
    const lines = sliceSectionLines('About');
    if (lines.length === 0) return null;
    // The visible "About" block is usually one or more paragraphs followed
    // by a "…show more" toggle. Filter out UI chrome, join paragraphs.
    const SKIP = /^(?:…|…\s*show more|see more|see less|show all)$/i;
    const TOP_OF_PAGE_FRAGMENTS = /^(home|my network|jobs|messaging|notifications)$/i;
    const body = lines
      .filter((l) => !SKIP.test(l))
      .filter((l) => !TOP_OF_PAGE_FRAGMENTS.test(l))
      .join('\n')
      .trim();
    if (body.length < 30) return null;
    return body.slice(0, 4000);
  }

  function scrapeExperienceFromInnerText() {
    const lines = sliceSectionLines('Experience');
    if (lines.length === 0) return [];
    // LinkedIn renders each role as a stack of lines. Date lines are the
    // most reliable delimiter — a line containing a 4-digit year alongside
    // a month or "Present" or another year marks the end of an entry's
    // header block.
    const DATE_LINE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s*\d{4}\b|\b\d{4}\s*[-–—]\s*(?:\d{4}|Present)\b/i;
    const SKIP = /^(?:…|see more|see less|show all|·|•|·\s*present)$/i;
    const out = [];
    let buf = [];
    function flush() {
      if (buf.length === 0) return;
      // Strip dedup (LinkedIn duplicates lines for a11y in some layouts)
      const dedup = buf.filter((l, i) => l !== buf[i - 1]);
      // Likely shape: line 0 = role title, line 1 = company [· employment type],
      // line 2 = date range, line 3 = location.
      // BUT for grouped roles (one company → multiple titles) the company is
      // line 0 and titles follow. We use date-line as the anchor: lines
      // ABOVE the date line are the role/company; first is title, second is
      // company.
      const dateIdx = dedup.findIndex((l) => DATE_LINE.test(l));
      let role = null, company = null, from = null, to = null;
      if (dateIdx >= 1) {
        role = dedup[0];
        company = dedup[1] ? dedup[1].split(/\s*[·•]\s*/)[0].trim() : null;
        const dl = dedup[dateIdx];
        const m = dl.match(/^(.*?)\s*[-–—]\s*(.*?)(\s*[·•].*)?$/);
        if (m) {
          from = (m[1] || '').trim() || null;
          const t = (m[2] || '').trim();
          to = /^present$/i.test(t) ? null : (t || null);
        }
      } else {
        // No date line — best-effort: first two lines as role/company.
        role = dedup[0] || null;
        company = dedup[1] || null;
      }
      if (role || company) out.push({ role, company, from, to });
      buf = [];
    }
    for (const line of lines) {
      if (SKIP.test(line)) continue;
      buf.push(line);
      // A second date line in the buffer marks a new entry starting.
      const dateMatches = buf.filter((l) => DATE_LINE.test(l)).length;
      if (dateMatches >= 2) {
        // The latest line that matched the date pattern starts the next
        // entry — pop it off, flush, then push it back.
        const last = buf.pop();
        flush();
        buf.push(last);
      }
      if (out.length >= 5) break;
    }
    flush();
    return out.slice(0, 5);
  }

  function scrapeEducationFromInnerText() {
    const lines = sliceSectionLines('Education');
    if (lines.length === 0) return [];
    // Each education entry: [school, degree+field, dates]. Use year-only
    // date patterns as separators ("2018 - 2022", "2020 - Present").
    const DATE_LINE = /\b\d{4}\s*[-–—]\s*(?:\d{4}|Present)\b/i;
    const SKIP = /^(?:…|see more|see less|show all|·|•)$/i;
    const out = [];
    let buf = [];
    function flush() {
      if (buf.length === 0) return;
      const dedup = buf.filter((l, i) => l !== buf[i - 1]);
      const school = dedup[0] || null;
      const degreeField = dedup[1] || null;
      const dateLine = dedup.find((l) => DATE_LINE.test(l));
      let from = null, to = null;
      if (dateLine) {
        const m = dateLine.match(/^(.*?)\s*[-–—]\s*(.*?)(\s*[·•].*)?$/);
        if (m) {
          from = (m[1] || '').trim() || null;
          const t = (m[2] || '').trim();
          to = /^present$/i.test(t) ? null : (t || null);
        }
      }
      if (school) out.push({ school, degree: degreeField, from, to });
      buf = [];
    }
    for (const line of lines) {
      if (SKIP.test(line)) continue;
      buf.push(line);
      const dateMatches = buf.filter((l) => DATE_LINE.test(l)).length;
      if (dateMatches >= 2) {
        const last = buf.pop();
        flush();
        buf.push(last);
      }
      if (out.length >= 5) break;
    }
    flush();
    return out.slice(0, 5);
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
        <div class="relay-cap-header">
          <div class="relay-cap-tile done">✓</div>
          <div>
            <div class="relay-cap-title">Imported to Relay</div>
            <div class="relay-cap-phase">${fields} · closing tab</div>
          </div>
        </div>
        <div class="relay-cap-bar"><div class="relay-cap-fill done" style="width:100%"></div></div>
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

  // LinkedIn lazy-loads the Activity section as you scroll. Without
  // scrolling, recentPosts comes back empty. We can't rely on a single
  // scroll — Activity may not be in the DOM yet on first call, and the
  // page itself grows as more sections render. Strategy: scroll
  // progressively (deeper each attempt) AND try to anchor on Activity
  // when it appears.
  let scrollStage = 0;
  function nudgeActivityIntoView() {
    try {
      // If Activity already exists, anchor to it directly — most reliable.
      const anchors = document.querySelectorAll('section, h2, div');
      for (const h of anchors) {
        // Use textContent of the FIRST text node so "Activity" doesn't
        // also match deeper labels like "Activity rate" or "Activity feed".
        const firstText = (h.firstChild?.textContent || h.textContent || '').trim();
        if (/^Activity$/i.test(firstText)) {
          h.scrollIntoView({ block: 'center', behavior: 'instant' });
          return true;
        }
      }
      // No Activity heading yet — scroll progressively. Each call advances
      // ~30vh further so we keep triggering lazy-loads as the page grows.
      const total = document.documentElement.scrollHeight;
      const viewport = window.innerHeight || 800;
      const target = Math.min(total - viewport, viewport * (1.5 + scrollStage * 1.0));
      window.scrollTo({ top: target, behavior: 'instant' });
      scrollStage++;
      return false;
    } catch { return false; }
  }

  // Whether the captured payload has enough to count as "good enough to
  // finalize". Posts are the slowest-loading section, so we wait for them
  // before declaring done. If they're still missing after the full budget,
  // we send what we have rather than dropping the whole capture.
  function hasIdealPayload(data) {
    return !!(data?.recentPosts && data.recentPosts.length > 0);
  }
  function hasMinimumPayload(data) {
    return !!(data?.about || (data?.prevRoles && data.prevRoles.length) || (data?.education && data.education.length));
  }

  function tryCapture() {
    if (sent) return;
    // Re-scroll on every attempt. Manual testing shows posts take ~5s to
    // render AFTER scrolling, and our retry cadence (1.5s · 4s · 6.5s · …)
    // needs at least one scroll → wait-5s → capture cycle to land.
    nudgeActivityIntoView();
    const data = extract();
    if (!data || !data.name) return;
    const elapsed = Date.now() - startedAt;
    // Phase A (until 10s): only send if we have posts — the section we're
    // most likely to miss without scrolling. Keep scrolling/waiting otherwise.
    // Phase B (after 10s): accept minimum payload so we don't drop everything
    // if the user's Activity section is genuinely empty.
    if (hasIdealPayload(data)) {
      send(data);
      if (observer) { observer.disconnect(); observer = null; }
      return;
    }
    if (elapsed >= 10_000 && hasMinimumPayload(data)) {
      send(data);
      if (observer) { observer.disconnect(); observer = null; }
      return;
    }
  }

  // Active-capture flow: banner + retries + DOM observer. Triggered either
  // by an app-initiated tab on load, or by the user clicking the floating
  // "Import to Relay" button on a natural visit.
  function startCapture({ silent = false } = {}) {
    if (sent) return;
    startedAt = Date.now();
    if (!silent) setupBanner();

    // Kick off TWO early scrolls — one before the page even renders
    // most of its sections (triggers initial lazy-load), one after the
    // structure should be in place to anchor on the Activity heading.
    setTimeout(nudgeActivityIntoView, 500);
    setTimeout(nudgeActivityIntoView, 2200);

    // Deterministic retry schedule. Extended beyond the original 13s ceiling
    // because Activity reliably needs ~10s to lazy-load after scroll. Tab
    // budget is now 25s (background.js) to match.
    const RETRY_AT_MS = [1500, 4000, 6500, 9000, 12000, 15000, 18000];
    for (const ms of RETRY_AT_MS) setTimeout(tryCapture, ms);

    // Final-shot extract at 22s — accept whatever we have, even if posts
    // never showed up. Better to save the profile than drop the capture.
    setTimeout(() => {
      if (sent) return;
      const data = extract();
      if (data && data.name) send(data);
    }, 22_000);

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

  // Floating "Import to Relay" pill — LinkedIn-native styling. Looks
  // like a LinkedIn primary action button: filled LinkedIn blue, pill
  // shape, weight 600, native shadow. IP avatar tile preserves brand identity.
  function showFloatingButton() {
    // Compliance: no injected on-page UI. The floating "Import to Relay" pill
    // is removed — strangers are no longer captured by click. Messageable
    // contacts still capture silently via the network tap.
    return;
    // eslint-disable-next-line no-unreachable
    try {
      if (document.getElementById('relay-floating-btn')) return;
      if (!document.getElementById('relay-floating-btn-style')) {
        const style = document.createElement('style');
        style.id = 'relay-floating-btn-style';
        style.textContent = `
          @keyframes relay-fb-in { from { opacity:0; transform: translateY(-50%) translateX(-8px); } to { opacity:1; transform: translateY(-50%) translateX(0); } }
          #relay-floating-btn {
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
            animation: relay-fb-in 220ms cubic-bezier(.25,1,.5,1);
            transition: background 120ms cubic-bezier(.25,1,.5,1), box-shadow 120ms, transform 120ms;
            -webkit-font-smoothing: antialiased;
          }
          #relay-floating-btn:hover {
            background: #004182;
            box-shadow: 0 0 0 1px rgba(0,0,0,.04), 0 6px 16px rgba(10,102,194,.40);
            transform: translateY(-50%) scale(1.02);
          }
          #relay-floating-btn:active {
            transform: translateY(-50%) scale(.98);
          }
          #relay-floating-btn .relay-fb-tile {
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
      btn.id = 'relay-floating-btn';
      btn.type = 'button';
      btn.innerHTML = `
        <span class="relay-fb-tile">IP</span>
        <span>Import to Relay</span>
      `;
      btn.addEventListener('click', () => {
        try { btn.remove(); } catch {}
        startCapture({ silent: false });
      });
      document.documentElement.appendChild(btn);
    } catch {}
  }

  // Tiny bottom-right toast for silent refreshes — confirms to the user
  // that Relay just updated their data without the more visible banner.
  // Auto-dismisses; can stack if user navigates between profiles quickly.
  function showSilentToast(data) {
    // Compliance: no injected on-page UI. The "Refreshed by Relay" toast is
    // removed — capture stays fully silent, no DOM changes on LinkedIn pages.
    return;
    // eslint-disable-next-line no-unreachable
    try {
      if (!document.getElementById('relay-silent-toast-style')) {
        const style = document.createElement('style');
        style.id = 'relay-silent-toast-style';
        style.textContent = `
          @keyframes relay-toast-in { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: translateY(0); } }
          @keyframes relay-toast-out { to { opacity:0; transform: translateY(8px); } }
          .relay-silent-toast {
            position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
            background: #FFFFFF; color: rgba(0,0,0,.9);
            border-radius: 8px;
            padding: 10px 14px;
            box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.15);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', system-ui, sans-serif;
            font-size: 13px; font-weight: 500;
            display: inline-flex; align-items: center; gap: 10px;
            animation: relay-toast-in 200ms cubic-bezier(.25,1,.5,1);
          }
          .relay-silent-toast.leaving { animation: relay-toast-out 240ms cubic-bezier(.55,0,.65,.2) forwards; }
          @media (prefers-color-scheme: dark) {
            .relay-silent-toast { background: #1B1F23; color: rgba(255,255,255,.9); box-shadow: 0 0 0 1px rgba(255,255,255,.1), 0 4px 12px rgba(0,0,0,.5); }
          }
          .relay-silent-toast .relay-toast-dot {
            width: 16px; height: 16px; border-radius: 50%;
            background: #057642; color: #FFFFFF;
            display: flex; align-items: center; justify-content: center;
            font-size: 10px; font-weight: 700; flex-shrink: 0;
          }
        `;
        document.head?.appendChild(style);
      }
      const toast = document.createElement('div');
      toast.className = 'relay-silent-toast';
      const fieldList = [
        data?.about ? 'About' : null,
        (data?.prevRoles?.length ?? 0) > 0 ? `${data.prevRoles.length} role${data.prevRoles.length === 1 ? '' : 's'}` : null,
        (data?.recentPosts?.length ?? 0) > 0 ? `${data.recentPosts.length} post${data.recentPosts.length === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join(' · ');
      toast.innerHTML = `
        <span class="relay-toast-dot">✓</span>
        <span>Refreshed by Relay${fieldList ? ` · <span style="opacity:.6">${fieldList}</span>` : ''}</span>
      `;
      document.documentElement.appendChild(toast);
      setTimeout(() => { toast.classList.add('leaving'); }, 2500);
      setTimeout(() => { try { toast.remove(); } catch {} }, 2900);
    } catch {}
  }

  // ─── User-driven capture (Refresh-profile flow only) ──────────────────
  // The user scrolls naturally through the profile. We watch the DOM via
  // a MutationObserver and re-extract on every change. A sticky checklist
  // banner shows which sections we've captured so the user knows when
  // they're done. Auto-closes the tab 5s after we detect we've got what
  // we need (or user manually clicks Done).

  let udBanner = null;
  let udObserver = null;
  let udIdleCheckTimer = null;
  let udCountdownTimer = null;
  let udCountdownRemaining = 0;
  let udLastMutationAt = 0;
  let udBestData = null;
  let udCaptured = { name: false, about: false, experience: false, education: false, posts: 0 };

  function setupUserDrivenBanner() {
    try {
      if (!document.getElementById('relay-ud-style')) {
        const style = document.createElement('style');
        style.id = 'relay-ud-style';
        style.textContent = `
          @keyframes relay-ud-in { from { opacity:0; transform: translateY(-8px); } to { opacity:1; transform: translateY(0); } }
          #relay-ud-banner {
            position: fixed; top: 12px; right: 12px; z-index: 2147483647;
            min-width: 300px; max-width: 360px;
            background: #FFFFFF; color: rgba(0,0,0,.9);
            border-radius: 12px;
            box-shadow: 0 0 0 1px rgba(0,0,0,.06), 0 12px 36px rgba(0,0,0,.2);
            padding: 14px 16px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', system-ui, sans-serif;
            font-size: 13px; line-height: 1.4;
            animation: relay-ud-in 240ms cubic-bezier(.25,1,.5,1);
            -webkit-font-smoothing: antialiased;
          }
          @media (prefers-color-scheme: dark) {
            #relay-ud-banner { background: #1B1F23; color: rgba(255,255,255,.92); box-shadow: 0 0 0 1px rgba(255,255,255,.1), 0 12px 36px rgba(0,0,0,.6); }
            #relay-ud-banner .relay-ud-sub { color: rgba(255,255,255,.55) !important; }
            #relay-ud-banner .relay-ud-check.pending { color: rgba(255,255,255,.4) !important; }
            #relay-ud-banner button.relay-ud-done { background: rgba(255,255,255,.08); color: rgba(255,255,255,.92); }
            #relay-ud-banner button.relay-ud-done:hover { background: rgba(255,255,255,.14); }
          }
          #relay-ud-banner .relay-ud-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
          #relay-ud-banner .relay-ud-tile {
            width: 28px; height: 28px; border-radius: 50%;
            background: #0A66C2; color: #FFFFFF;
            display: inline-flex; align-items: center; justify-content: center;
            font-weight: 700; font-size: 11px; letter-spacing: 0.3px; flex-shrink: 0;
          }
          #relay-ud-banner .relay-ud-title { font-weight: 600; font-size: 13px; }
          #relay-ud-banner .relay-ud-sub { font-size: 11.5px; color: rgba(0,0,0,.55); margin-top: 1px; }
          #relay-ud-banner .relay-ud-list {
            display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; margin: 8px 0 10px;
          }
          #relay-ud-banner .relay-ud-check {
            font-size: 12px; display: inline-flex; align-items: center; gap: 6px;
            transition: color 180ms ease, transform 240ms cubic-bezier(.25,1,.5,1);
          }
          #relay-ud-banner .relay-ud-check.done { color: #057642; font-weight: 500; }
          #relay-ud-banner .relay-ud-check.pending { color: rgba(0,0,0,.45); }
          #relay-ud-banner .relay-ud-mark { font-weight: 700; font-size: 13px; width: 14px; display: inline-block; text-align: center; }
          #relay-ud-banner .relay-ud-bar {
            height: 4px; background: rgba(10,102,194,.12); border-radius: 999px; overflow: hidden;
            margin-bottom: 8px;
          }
          #relay-ud-banner .relay-ud-fill {
            height: 100%; background: #0A66C2; border-radius: 999px;
            transition: width 240ms cubic-bezier(.25,1,.5,1); width: 0%;
          }
          #relay-ud-banner .relay-ud-fill.done { background: #057642; }
          #relay-ud-banner .relay-ud-foot {
            display: flex; align-items: center; justify-content: space-between; gap: 8px;
            font-size: 11.5px;
          }
          #relay-ud-banner .relay-ud-hint { color: rgba(0,0,0,.55); }
          #relay-ud-banner button.relay-ud-done {
            background: rgba(0,0,0,.06); border: 0; border-radius: 6px;
            font-family: inherit; font-size: 11.5px; font-weight: 600;
            color: rgba(0,0,0,.85); cursor: pointer;
            padding: 5px 10px;
            transition: background 140ms ease;
          }
          #relay-ud-banner button.relay-ud-done:hover { background: rgba(0,0,0,.1); }
          #relay-ud-banner.finishing .relay-ud-tile { background: #057642; }
          #relay-ud-banner.finishing .relay-ud-bar { background: rgba(5,118,66,.15); }
        `;
        document.head?.appendChild(style);
      }
      const el = document.createElement('div');
      el.id = 'relay-ud-banner';
      el.innerHTML = `
        <div class="relay-ud-row">
          <div class="relay-ud-tile">IP</div>
          <div style="flex:1; min-width:0;">
            <div class="relay-ud-title">Capturing this profile</div>
            <div class="relay-ud-sub relay-ud-status">Scroll down — we'll catch the rest as it loads</div>
          </div>
        </div>
        <div class="relay-ud-list">
          <span class="relay-ud-check pending" data-key="about"><span class="relay-ud-mark">·</span>About</span>
          <span class="relay-ud-check pending" data-key="experience"><span class="relay-ud-mark">·</span>Experience</span>
          <span class="relay-ud-check pending" data-key="education"><span class="relay-ud-mark">·</span>Education</span>
          <span class="relay-ud-check pending" data-key="posts"><span class="relay-ud-mark">·</span>Posts (0)</span>
        </div>
        <div class="relay-ud-bar"><div class="relay-ud-fill"></div></div>
        <div class="relay-ud-foot">
          <span class="relay-ud-hint">Tab closes when we have everything</span>
          <button class="relay-ud-done" type="button">Done</button>
        </div>
      `;
      document.documentElement.appendChild(el);
      udBanner = el;
      el.querySelector('button.relay-ud-done')?.addEventListener('click', () => {
        startCountdown(true);
      });
    } catch {}
  }

  function updateBannerChecklist() {
    if (!udBanner) return;
    const flag = (key, on) => {
      const node = udBanner.querySelector(`.relay-ud-check[data-key="${key}"]`);
      if (!node) return;
      node.classList.toggle('done', !!on);
      node.classList.toggle('pending', !on);
      const mark = node.querySelector('.relay-ud-mark');
      if (mark) mark.textContent = on ? '✓' : '·';
    };
    flag('about', udCaptured.about);
    flag('experience', udCaptured.experience);
    flag('education', udCaptured.education);
    const postsNode = udBanner.querySelector('.relay-ud-check[data-key="posts"]');
    if (postsNode) {
      const on = udCaptured.posts > 0;
      postsNode.classList.toggle('done', on);
      postsNode.classList.toggle('pending', !on);
      const mark = postsNode.querySelector('.relay-ud-mark');
      if (mark) mark.textContent = on ? '✓' : '·';
      postsNode.lastChild.textContent = `Posts (${udCaptured.posts})`;
    }
    const total = 4;
    const done = (udCaptured.about ? 1 : 0) + (udCaptured.experience ? 1 : 0) + (udCaptured.education ? 1 : 0) + (udCaptured.posts > 0 ? 1 : 0);
    const pct = Math.round((done / total) * 100);
    const fill = udBanner.querySelector('.relay-ud-fill');
    if (fill) fill.style.width = `${pct}%`;
  }

  function reExtractUserDriven() {
    if (sent) return;
    const data = extract();
    if (!data || !data.name) return;
    // Always keep the most recent extract — later passes have more.
    udBestData = data;
    udCaptured.name = true;
    udCaptured.about = !!data.about;
    udCaptured.experience = !!(data.prevRoles && data.prevRoles.length);
    udCaptured.education = !!(data.education && data.education.length);
    udCaptured.posts = (data.recentPosts && data.recentPosts.length) || 0;
    updateBannerChecklist();
    maybeFinishUserDriven();
  }

  function maybeFinishUserDriven() {
    if (sent || udCountdownTimer) return;
    const allMajor = udCaptured.about && udCaptured.experience && udCaptured.posts > 0;
    if (allMajor) { startCountdown(false); return; }
    // Bottom-reached fallback: user scrolled to the end + DOM is idle 3s +
    // we have at least About + Experience. Posts may genuinely be empty.
    const reachedBottom =
      (window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 300;
    const idle = Date.now() - udLastMutationAt > 3000;
    if (udCaptured.about && udCaptured.experience && reachedBottom && idle) {
      startCountdown(false);
    }
  }

  function startCountdown(userClicked) {
    if (sent || udCountdownTimer) return;
    udCountdownRemaining = 5;
    if (udBanner) {
      udBanner.classList.add('finishing');
      const status = udBanner.querySelector('.relay-ud-status');
      const hint = udBanner.querySelector('.relay-ud-hint');
      const btn = udBanner.querySelector('button.relay-ud-done');
      if (status) status.textContent = userClicked ? 'Locking in what we have…' : 'Got it — sending you back to Relay';
      if (hint) hint.textContent = '';
      if (btn) {
        btn.textContent = `Closing in ${udCountdownRemaining}s`;
        btn.disabled = true;
        btn.style.opacity = '0.6';
        btn.style.cursor = 'default';
      }
    }
    udCountdownTimer = setInterval(() => {
      udCountdownRemaining--;
      if (udBanner) {
        const btn = udBanner.querySelector('button.relay-ud-done');
        if (btn) btn.textContent = `Closing in ${udCountdownRemaining}s`;
      }
      if (udCountdownRemaining <= 0) {
        clearInterval(udCountdownTimer);
        udCountdownTimer = null;
        if (udObserver) { try { udObserver.disconnect(); } catch {} udObserver = null; }
        if (udIdleCheckTimer) { clearInterval(udIdleCheckTimer); udIdleCheckTimer = null; }
        if (udBestData) send(udBestData);
      }
    }, 1000);
  }

  function startCaptureUserDriven() {
    if (sent) return;
    startedAt = Date.now();
    udLastMutationAt = Date.now();
    setupUserDrivenBanner();
    // Initial extract — most pages have at least the name + headline visible
    // immediately. Updates the banner from "all pending" to a partial state.
    reExtractUserDriven();
    // MutationObserver: re-extract on any DOM change. Throttled implicitly
    // by browser batching; we still skip when sent.
    let rafQueued = false;
    udObserver = new MutationObserver(() => {
      udLastMutationAt = Date.now();
      if (rafQueued || sent) return;
      rafQueued = true;
      requestAnimationFrame(() => {
        rafQueued = false;
        reExtractUserDriven();
      });
    });
    udObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    // Idle-bottom check: scrolling alone doesn't fire mutations. Poll once
    // per second to evaluate the bottom-reached-and-idle finish condition.
    udIdleCheckTimer = setInterval(maybeFinishUserDriven, 1000);
    // Hard safety: even if the user idles forever, send what we have at 90s.
    setTimeout(() => {
      if (sent || udCountdownTimer) return;
      if (udBestData) startCountdown(false);
    }, 90_000);
  }

  // Bootstrap: decide what to do based on tab origin + contact status.
  //   1. App-initiated tab (Refresh button etc.) → user-driven capture.
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
      startCaptureUserDriven();
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
    try { document.getElementById('relay-floating-btn')?.remove(); } catch {}
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
