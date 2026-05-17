import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, safeParseArray, optionsResponse } from '@/lib/api-utils';
import type { Participant } from '@/types';
import { logParserResult } from '@/lib/parser-log';

// POST { fields } where fields is the output of extractFromVoyager:
//   { publicIdentifier, headline, role, company, location, industry,
//     about, prevRoles[], education[], skills[] }
//
// Called passively by content.js when LinkedIn's UI fetches profile data
// in ANY tab — including the background auto-enrich hidden tabs. We match
// to an existing Contact by publicIdentifier (profileSlug). If found, we
// merge the rich fields into the Contact AND any Conversation whose primary
// participant matches.
//
// Conservative: never CREATES a Contact from this path. Only enriches
// existing ones.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const f = body?.fields;
    if (!f || typeof f !== 'object') {
      return NextResponse.json({ error: 'fields object required' }, { status: 400, headers: CORS });
    }
    const publicId = typeof f.publicIdentifier === 'string' ? f.publicIdentifier : null;
    if (!publicId) {
      // No publicIdentifier means the Voyager response shape didn't match
      // what extractFromVoyager expects → likely LinkedIn changed something.
      logParserResult('voyager-tap', false, { reason: 'no-publicIdentifier' });
      return NextResponse.json({ ok: false, reason: 'no publicIdentifier' }, { headers: CORS });
    }

    const contact = await prisma.contact.findUnique({ where: { profileSlug: publicId } });
    if (!contact) {
      // Shape parsed correctly but contact not in our DB. Not a parser miss
      // — count as success so we don't false-positive on strangers.
      logParserResult('voyager-tap', true, { matched: false });
      return NextResponse.json({ ok: false, reason: 'no matching contact' }, { headers: CORS });
    }

    const fieldCount = ['headline','role','company','location','industry','about','prevRoles','education','recentPosts','skills']
      .filter((k) => f[k] !== undefined && f[k] !== null && f[k] !== '').length;
    logParserResult('voyager-tap', true, { matched: true, fieldCount });

    const now = new Date();
    const patch: Record<string, unknown> = { lastSeenAt: now };
    if (typeof f.headline === 'string' && (!contact.headline || f.headline !== contact.headline)) patch.headline = f.headline;
    if (typeof f.role === 'string' && (!contact.role || f.role !== contact.role)) patch.role = f.role;
    if (typeof f.company === 'string' && (!contact.company || f.company !== contact.company)) patch.company = f.company;
    if (typeof f.location === 'string' && !contact.location) patch.location = f.location;
    if (typeof f.industry === 'string' && !contact.industry) patch.industry = f.industry;
    if (typeof f.about === 'string' && f.about.length > 0) patch.about = f.about;
    if (Array.isArray(f.prevRoles) && f.prevRoles.length > 0) patch.prevRoles = JSON.stringify(f.prevRoles);
    if (Array.isArray(f.education) && f.education.length > 0) patch.education = JSON.stringify(f.education);
    if (Array.isArray(f.recentPosts) && f.recentPosts.length > 0) {
      patch.recentPosts = JSON.stringify(f.recentPosts);
      patch.recentPostsAt = now;
    }

    if (Object.keys(patch).length > 1) {
      await prisma.contact.update({ where: { id: contact.id }, data: patch });
    }

    // Also mirror into any conversation whose primary participant has the
    // matching profileUrl — so the right-panel shows the rich data without
    // waiting for another enrich pass.
    const profileUrl = `https://www.linkedin.com/in/${publicId}/`;
    const convs = await prisma.conversation.findMany({
      where: { participants: { contains: profileUrl } },
      select: { id: true, enrichment: true, participants: true },
    });
    let mirrored = 0;
    for (const c of convs) {
      const parts = safeParseArray<Participant>(c.participants, []);
      // Only mirror if this person is the primary participant
      if (!parts[0]?.profileUrl?.includes(`/in/${publicId}`)) continue;
      let existing: Record<string, unknown> = {};
      if (c.enrichment) {
        try { existing = JSON.parse(c.enrichment); } catch {}
      }
      const merged = {
        ...existing,
        ...(typeof f.headline === 'string' ? { headline: f.headline } : {}),
        ...(typeof f.role === 'string' ? { role: f.role } : {}),
        ...(typeof f.company === 'string' ? { company: f.company } : {}),
        ...(typeof f.location === 'string' ? { location: f.location } : {}),
        ...(typeof f.industry === 'string' ? { industry: f.industry } : {}),
        ...(typeof f.about === 'string' ? { about: f.about } : {}),
        ...(Array.isArray(f.prevRoles) ? { prevRoles: f.prevRoles } : {}),
        ...(Array.isArray(f.education) ? { education: f.education } : {}),
        ...(Array.isArray(f.skills) ? { skills: f.skills } : {}),
        ...(Array.isArray(f.recentPosts) ? { recentPosts: f.recentPosts } : {}),
        profileUrl: existing.profileUrl ?? profileUrl,
        source: 'dom-capture',
      };
      await prisma.conversation.update({
        where: { id: c.id },
        data: { enrichment: JSON.stringify(merged), enrichmentAt: now },
      });
      mirrored++;
    }

    return NextResponse.json(
      { ok: true, contactId: contact.id, conversationsMirrored: mirrored },
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
