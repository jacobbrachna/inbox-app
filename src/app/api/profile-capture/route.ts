import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, safeParseArray, optionsResponse } from '@/lib/api-utils';
import type { Participant } from '@/types';
import { upsertContact, linkContactToConversation, extractProfileSlug } from '@/lib/contact-upsert';
import { logParserResult } from '@/lib/parser-log';

// POST { url, name, headline?, location?, company?, role? }
// Called by the /in/* content script. We match by name (case-insensitive,
// whitespace-normalized) and patch participant.profileUrl + conv.enrichment.
// When multiple conversations match a single name, we prefer ones with no
// existing profileUrl. Verified-DOM data overrides AI-headline data.
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const url = typeof body.url === 'string' ? body.url : '';
    const name = typeof body.name === 'string' ? body.name : '';
    if (!url || !name) {
      return NextResponse.json({ error: 'url and name required' }, { status: 400, headers: CORS });
    }

    const headline = typeof body.headline === 'string' ? body.headline : undefined;
    const location = typeof body.location === 'string' ? body.location : undefined;
    const company = typeof body.company === 'string' ? body.company : undefined;
    const role = typeof body.role === 'string' ? body.role : undefined;
    const about = typeof body.about === 'string' ? body.about : undefined;
    const prevRoles = Array.isArray(body.prevRoles) ? body.prevRoles : undefined;
    const education = Array.isArray(body.education) ? body.education : undefined;
    const recentPosts = Array.isArray(body.recentPosts) ? body.recentPosts : undefined;

    // Telemetry: success = we got at least name+(role|company|about). The
    // banner-only case (name + nothing else) means the scraper completed
    // but LinkedIn's structure wasn't where we expected → likely shape drift.
    const richSuccess = !!(role || company || about || (Array.isArray(prevRoles) && prevRoles.length));
    logParserResult('profile-capture-dom', richSuccess, {
      hasName: !!name,
      hasRole: !!role,
      hasCompany: !!company,
      hasAbout: !!about,
      prevRolesCount: Array.isArray(prevRoles) ? prevRoles.length : 0,
    });

    // Find candidates by normalized name
    // (SQLite collation is case-insensitive only for ASCII — do it in JS).
    const all = await prisma.conversation.findMany({
      select: { id: true, participants: true, enrichment: true },
    });
    const target = normalize(name);
    const matches = all.filter((c) => {
      const parts = safeParseArray<Participant>(c.participants, []);
      return parts.some((p) => normalize(p.name ?? '') === target);
    });

    // Prefer matches without an existing profileUrl
    const sorted = matches.sort((a, b) => {
      const aParts = safeParseArray<Participant>(a.participants, []);
      const bParts = safeParseArray<Participant>(b.participants, []);
      const aHas = aParts.some((p) => p.profileUrl);
      const bHas = bParts.some((p) => p.profileUrl);
      return (aHas ? 1 : 0) - (bHas ? 1 : 0);
    });

    let updated = 0;
    for (const c of sorted) {
      const parts = safeParseArray<Participant>(c.participants, []);
      let participantChanged = false;
      const nextParts = parts.map((p) => {
        if (normalize(p.name ?? '') !== target) return p;
        if (p.profileUrl) return p; // already set on this participant
        participantChanged = true;
        return { ...p, profileUrl: url };
      });

      // Merge enrichment with SOURCE PRECEDENCE so we don't downgrade better
      // data with worse. Priority (high → low):
      //   linkedin-export > dom-capture > ai-headline > harvest > unknown
      // DOM capture can ADD new fields but never overwrite linkedin-export.
      let existing: Record<string, unknown> = {};
      if (c.enrichment) {
        try { existing = JSON.parse(c.enrichment); } catch {}
      }
      const PRIORITY: Record<string, number> = {
        'linkedin-export': 4,
        'dom-capture': 3,
        'ai-headline': 2,
        'harvest': 1,
      };
      const existingSource = typeof existing.source === 'string' ? existing.source : '';
      const existingPriority = PRIORITY[existingSource] ?? 0;
      const incomingPriority = PRIORITY['dom-capture'];
      const canOverwriteFields = incomingPriority >= existingPriority;

      const merged: Record<string, unknown> = { ...existing };
      // profileUrl is always safe to add when missing
      if (!merged.profileUrl && url) merged.profileUrl = url;
      // Other fields only overwrite when our source rank >= existing
      if (company && (canOverwriteFields || !merged.company)) merged.company = company;
      if (role && (canOverwriteFields || !merged.role)) merged.role = role;
      if (location && (canOverwriteFields || !merged.location)) merged.location = location;
      if (headline && (canOverwriteFields || !merged.headline)) merged.headline = headline;
      // Rich Phase 2 fields — overwrite when present (DOM scrape is the most
      // current source for these).
      if (about) merged.about = about;
      if (prevRoles) merged.prevRoles = prevRoles;
      if (education) merged.education = education;
      if (recentPosts) merged.recentPosts = recentPosts;
      // Only bump source upward, never down
      if (canOverwriteFields) merged.source = 'dom-capture';

      const enrichmentChanged = JSON.stringify(merged) !== c.enrichment;

      if (participantChanged || enrichmentChanged) {
        await prisma.conversation.update({
          where: { id: c.id },
          data: {
            ...(participantChanged ? { participants: JSON.stringify(nextParts) } : {}),
            ...(enrichmentChanged ? { enrichment: JSON.stringify(merged), enrichmentAt: new Date() } : {}),
          },
        });
        updated++;
      }
    }

    // Mirror to Contact table. DOM-capture priority (3) is higher than
    // harvest, lower than CSV import — so partial fills are safe.
    const contactId = await upsertContact({
      profileUrl: url,
      profileSlug: extractProfileSlug(url),
      name,
      headline: headline ?? null,
      company: company ?? null,
      role: role ?? null,
      location: location ?? null,
      about: about ?? null,
      prevRoles: prevRoles ?? null,
      education: education ?? null,
      recentPosts: recentPosts ?? null,
      source: 'dom-capture',
    });
    if (contactId) {
      // Link to every conversation we just patched.
      for (const c of sorted) {
        await linkContactToConversation(contactId, c.id);
      }
    }

    return NextResponse.json({ ok: true, matched: matches.length, updated, contactId }, { headers: CORS });
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
