import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, safeParseArray, optionsResponse } from '@/lib/api-utils';
import type { Participant } from '@/types';
import {
  upsertContact,
  linkContactToConversation,
  extractProfileSlug,
  parseLinkedInDate,
  type ContactSource,
} from '@/lib/contact-upsert';

// POST { items: [{ url, name }, ...] }
// Bulk version of /api/profile-capture for the URL harvest. We normalize all
// names once, fetch every conv once, then match in JS to avoid N+1 SQL.
// Only PATCHES participants missing a profileUrl — never destructive.
function normalize(s: string): string {
  return s
    .toLowerCase()
    // Strip credentials / suffixes that come after a comma: "Marc Mackey, MBA, MS, CSM" → "Marc Mackey"
    .split(',')[0]
    // Strip parenthetical asides: "John Smith (he/him)" → "John Smith"
    .replace(/\([^)]*\)/g, '')
    // Strip emoji + non-word symbols (LinkedIn names sometimes have 🚀 etc)
    .replace(/[^\p{L}\p{N}\s'.-]/gu, '')
    // Collapse punctuation we don't want to compare on
    .replace(/[.'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Derive a candidate name from the URL slug as a fallback match key.
// "/in/kiran-kumar-b58971b2/" → "kiran kumar"
function nameFromSlug(url: string): string {
  try {
    const u = new URL(url);
    const slug = u.pathname.replace(/^\/in\/|\/+$/g, '');
    const parts = slug.split('-');
    while (parts.length && /^[a-z0-9]{5,}$/i.test(parts[parts.length - 1])) {
      parts.pop();
    }
    return parts.join(' ');
  } catch {
    return '';
  }
}

interface Item {
  url: string;
  name: string;
  avatarUrl?: string | null;
  company?: string | null;
  role?: string | null;
  connectedOn?: string | null;
}

// LinkedIn CDN URL → stable per-photo image ID
//   https://media.licdn.com/dms/image/v2/D4D03AQF…/profile-display…
//                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^
// The segment after /image/v[12]/ is stable across rendering surfaces.
function avatarId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/image\/(?:v\d+\/)?([A-Z0-9_-]{10,})/i);
  return m ? m[1] : null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const items: Item[] = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) {
      return NextResponse.json({ ok: true, updated: 0, scanned: 0 }, { headers: CORS });
    }

    // Build three indexes, each keyed differently:
    //   • byName:   normalized name OR normalized slug → profile URL
    //   • byAvatar: stable LinkedIn image-ID (D4D03AQ…) → profile URL
    // Avatar IDs are a strong fallback when names diverge (credentials, emoji,
    // unicode normalization, etc).
    const byName = new Map<string, string>();
    const byAvatar = new Map<string, string>();
    // Keep optional metadata keyed by URL so we can patch company/role on
    // matched conversations (used by the LinkedIn export importer).
    const metaByUrl = new Map<string, { company?: string; role?: string; connectedOn?: string }>();
    for (const it of items) {
      if (!it.url) continue;
      const keys = new Set<string>();
      if (it.name) keys.add(normalize(it.name));
      const slugKey = normalize(nameFromSlug(it.url));
      if (slugKey) keys.add(slugKey);
      for (const k of keys) {
        if (!k) continue;
        const existing = byName.get(k);
        if (!existing || it.url.length < existing.length) byName.set(k, it.url);
      }
      const aid = avatarId(it.avatarUrl);
      if (aid) {
        const existing = byAvatar.get(aid);
        if (!existing || it.url.length < existing.length) byAvatar.set(aid, it.url);
      }
      if (it.company || it.role || it.connectedOn) {
        metaByUrl.set(it.url, {
          ...(it.company ? { company: it.company } : {}),
          ...(it.role ? { role: it.role } : {}),
          ...(it.connectedOn ? { connectedOn: it.connectedOn } : {}),
        });
      }
    }

    if (byName.size === 0 && byAvatar.size === 0) {
      return NextResponse.json({ ok: true, updated: 0, scanned: 0 }, { headers: CORS });
    }

    // Upsert a Contact for EVERY harvested item — this is the key fix that
    // turns "ghost connections" into queryable records. Items with metadata
    // from the LinkedIn CSV export get higher source priority.
    const contactIdByUrl = new Map<string, string>();
    let contactsCreated = 0;
    for (const it of items) {
      if (!it.url || !it.name) continue;
      const source: ContactSource = (it.company || it.role || it.connectedOn)
        ? 'linkedin-export'
        : 'harvest';
      const cid = await upsertContact({
        profileUrl: it.url,
        profileSlug: extractProfileSlug(it.url),
        name: it.name,
        avatarUrl: it.avatarUrl ?? null,
        company: it.company ?? null,
        role: it.role ?? null,
        connectedOn: parseLinkedInDate(it.connectedOn),
        source,
      });
      if (cid) {
        contactIdByUrl.set(it.url, cid);
        contactsCreated++;
      }
    }

    // Pull all conversations once and match in memory
    const convs = await prisma.conversation.findMany({
      select: { id: true, participants: true, enrichment: true },
    });

    let updated = 0;
    let nameHits = 0;
    let avatarHits = 0;
    for (const c of convs) {
      const parts = safeParseArray<Participant>(c.participants, []);
      let participantChanged = false;
      const nextParts = parts.map((p) => {
        if (p.profileUrl) return p;
        // Try name match first
        const n = normalize(p.name ?? '');
        let url = n ? byName.get(n) : undefined;
        if (url) {
          nameHits++;
        } else {
          // Fallback: avatar image-ID match
          const aid = avatarId(p.avatarUrl);
          if (aid) {
            url = byAvatar.get(aid);
            if (url) avatarHits++;
          }
        }
        if (!url) return p;
        participantChanged = true;
        return { ...p, profileUrl: url };
      });

      if (!participantChanged) continue;

      // Also store on enrichment so the UI has a single source of truth.
      // If the matched URL has metadata (company/role from LinkedIn export),
      // merge it in — overrides any AI-derived headline enrichment with
      // verified-from-LinkedIn data.
      let existingEnrichment: Record<string, unknown> = {};
      if (c.enrichment) {
        try { existingEnrichment = JSON.parse(c.enrichment); } catch {}
      }
      const primary = nextParts[0];
      const meta = primary?.profileUrl ? metaByUrl.get(primary.profileUrl) : undefined;
      const enriched = primary?.profileUrl
        ? {
            ...existingEnrichment,
            profileUrl: primary.profileUrl,
            // Metadata from LinkedIn export wins when present
            ...(meta?.company ? { company: meta.company } : {}),
            ...(meta?.role ? { role: meta.role } : {}),
            ...(meta?.connectedOn ? { connectedOn: meta.connectedOn } : {}),
            source: meta ? 'linkedin-export' : (existingEnrichment.source ?? 'harvest'),
          }
        : existingEnrichment;

      await prisma.conversation.update({
        where: { id: c.id },
        data: {
          participants: JSON.stringify(nextParts),
          ...(primary?.profileUrl ? { enrichment: JSON.stringify(enriched), enrichmentAt: new Date() } : {}),
        },
      });
      updated++;

      // Link each newly-attributed participant to its Contact row.
      for (const p of nextParts) {
        if (!p.profileUrl) continue;
        const cid = contactIdByUrl.get(p.profileUrl);
        if (cid) await linkContactToConversation(cid, c.id);
      }
    }

    // Diagnostic: surface a few unmatched harvest names + a few unmatched
    // contact names so we can see WHY the matching is failing.
    if (updated < byName.size * 0.1) {
      const harvestKeys = [...byName.keys()];
      const contactKeys = convs
        .map((c) => {
          const parts = safeParseArray<Participant>(c.participants, []);
          return parts[0]?.name ? normalize(parts[0].name) : null;
        })
        .filter(Boolean) as string[];
      const harvestSet = new Set(harvestKeys);
      const contactSet = new Set(contactKeys);
      const harvestNotMatched = harvestKeys.filter((k) => !contactSet.has(k)).slice(0, 8);
      const contactNotMatched = contactKeys.filter((k) => !harvestSet.has(k)).slice(0, 8);
      try {
        await fetch('http://localhost:3030/api/sync-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            src: 'server',
            ev: 'harvest.matchDebug',
            harvestKeys: harvestKeys.length,
            contactKeys: contactKeys.length,
            matched: updated,
            harvestSample: harvestNotMatched.slice(0, 6),
            contactSample: contactNotMatched.slice(0, 6),
          }),
        });
      } catch {}
    }

    // Running total of contacts that have a profileUrl after this batch.
    // Lets the UI show cumulative progress across multiple harvest runs.
    const totalWithUrl = await prisma.conversation.count({
      where: { participants: { contains: 'profileUrl' } },
    });

    return NextResponse.json(
      {
        ok: true,
        scanned: byName.size,
        updated,
        nameHits,
        avatarHits,
        totalContacts: convs.length,
        totalWithUrl,
        contactsUpserted: contactsCreated,
      },
      { headers: CORS },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'unknown' },
      { status: 500, headers: CORS },
    );
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
