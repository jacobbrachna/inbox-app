// Passive link harvester. Runs on LinkedIn pages where /in/<slug>/ links are
// visible (My Network home, Notifications). No buttons, no scrolling, no UI —
// just snapshots whatever's already rendered and posts to InboxPro.
//
// Catches new connections naturally: you accept a request, LinkedIn renders
// the notification with the person's profile link, we capture it.

(() => {
  if (window.__inboxproLinkHarvester) return;
  window.__inboxproLinkHarvester = true;

  const INBOXPRO_URL = 'http://localhost:3030';
  const seen = new Set();

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

  function leadingName(s) {
    if (!s) return '';
    const boundary = s.search(/\p{Ll}\p{Lu}/u);
    if (boundary > 0) s = s.slice(0, boundary + 1);
    const m = s.match(/^(\p{Lu}[\p{Ll}'\-]+(?:\s+\p{Lu}[\p{Ll}.'\-]*\.?){1,3})/u);
    if (m) return m[1].trim();
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
    } catch {
      return '';
    }
  }

  function extractName(a) {
    const aria = a.getAttribute('aria-label')?.trim();
    if (aria) {
      const ld = leadingName(aria);
      if (ld) return ld;
    }
    const txt = a.textContent?.replace(/\s+/g, ' ').trim();
    if (txt) {
      const ld = leadingName(txt);
      if (ld) return ld;
    }
    // Walk up for name-shaped spans
    let parent = a.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      const spans = parent.querySelectorAll('span[aria-hidden="true"], h2, h3');
      for (const s of spans) {
        const t = s.textContent?.replace(/\s+/g, ' ').trim();
        const ld = t && leadingName(t);
        if (ld) return ld;
      }
      parent = parent.parentElement;
    }
    return nameFromSlug(a.href);
  }

  function extractAvatar(a) {
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

  function scan() {
    const anchors = document.querySelectorAll('a[href*="/in/"]');
    const newItems = [];
    for (const a of anchors) {
      const url = normalizeUrl(a.href);
      if (!url || seen.has(url)) continue;
      const name = extractName(a);
      if (!name) continue;
      seen.add(url);
      newItems.push({ url, name, avatarUrl: extractAvatar(a) });
    }
    if (newItems.length > 0) {
      fetch(`${INBOXPRO_URL}/api/profile-capture/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: newItems }),
      }).catch(() => {});
      fetch(`${INBOXPRO_URL}/api/sync-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          src: 'linkHarvester',
          ev: 'links.captured',
          page: location.pathname,
          count: newItems.length,
        }),
      }).catch(() => {});
    }
  }

  // Initial scan + watch DOM for new links (React renders + lazy load)
  setTimeout(scan, 1200);
  const observer = new MutationObserver(() => {
    // Debounce — only scan once per 1.5s of DOM activity
    clearTimeout(window.__inboxproLinkScanT);
    window.__inboxproLinkScanT = setTimeout(scan, 1500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Stop watching after 10 min — page should be settled by then
  setTimeout(() => observer.disconnect(), 10 * 60 * 1000);
})();
