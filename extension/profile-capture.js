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
  const startedAt = Date.now();

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

    return {
      url: ogUrl,
      name,
      headline: headline || null,
      role,
      company,
      location: locationName,
    };
  }

  function send(data) {
    if (sent) return;
    sent = true;
    fetch(`${INBOXPRO_URL}/api/profile-capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(() => {});
    // Also a diagnostic so we can see what was captured
    fetch(`${INBOXPRO_URL}/api/sync-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        src: 'profileCapture',
        ev: 'capture.sent',
        url: data.url,
        name: data.name,
        company: data.company,
        role: data.role,
      }),
    }).catch(() => {});
  }

  function tryCapture() {
    if (sent) return;
    const data = extract();
    if (!data || !data.name) return;
    send(data);
    if (observer) { observer.disconnect(); observer = null; }
  }

  // First attempt — page may have already rendered
  setTimeout(tryCapture, 250);

  // Watch for further mutations until we successfully capture or give up
  observer = new MutationObserver(() => {
    tryCapture();
    if (Date.now() - startedAt > 15_000) {
      try { observer.disconnect(); } catch {}
      observer = null;
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Hard timeout
  setTimeout(() => {
    if (observer) { observer.disconnect(); observer = null; }
  }, 15_000);
})();
