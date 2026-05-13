import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// POST { body: string } — raw JSON from /sales-api/salesApiProfiles/(...)
// Shape: { data: { firstName, lastName, fullName, headline, entityUrn,
//                  profilePictureDisplayImage, defaultPosition, ... },
//          included?: [...] }
//
// We use this to enrich SN conversations with the contact's headline. The
// inbox-list/thread endpoints don't include headline — only this one does.

type DefaultPosition = {
  title?: string;
  companyName?: string;
};

type SnProfile = {
  entityUrn?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  headline?: string;
  defaultPosition?: DefaultPosition;
  profilePictureDisplayImage?: {
    rootUrl?: string;
    artifacts?: Array<{ fileIdentifyingUrlPathSegment?: string }>;
  };
};

function avatarFromProfile(p: SnProfile): string {
  const arts = p.profilePictureDisplayImage?.artifacts;
  if (!Array.isArray(arts) || arts.length === 0) return '';
  const seg = arts[0]?.fileIdentifyingUrlPathSegment;
  if (typeof seg !== 'string') return '';
  const root = p.profilePictureDisplayImage?.rootUrl ?? '';
  return root + seg;
}

function deriveHeadline(p: SnProfile): string {
  if (typeof p.headline === 'string' && p.headline.trim()) return p.headline.trim();
  // Fall back to "<title> at <company>" if headline is missing
  const t = p.defaultPosition?.title?.trim();
  const c = p.defaultPosition?.companyName?.trim();
  if (t && c) return `${t} at ${c}`;
  if (t) return t;
  return '';
}

type Participant = {
  id?: string; name?: string; headline?: string;
  avatarUrl?: string; profileUrl?: string;
};

export async function POST(req: NextRequest) {
  try {
    const { body: rawBody } = await req.json();
    if (typeof rawBody !== 'string') {
      return NextResponse.json({ error: 'body required' }, { status: 400, headers: CORS });
    }
    let payload: { data?: SnProfile };
    try { payload = JSON.parse(rawBody); }
    catch (e) {
      return NextResponse.json(
        { error: 'JSON parse failed: ' + (e instanceof Error ? e.message : 'unknown') },
        { status: 400, headers: CORS },
      );
    }

    const p = payload?.data;
    if (!p || typeof p !== 'object' || !p.entityUrn) {
      return NextResponse.json(
        { ok: false, reason: 'no profile in data' },
        { headers: CORS },
      );
    }

    const name = (p.fullName?.trim())
      || `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim();
    const headline = deriveHeadline(p);
    const avatarUrl = avatarFromProfile(p);

    if (!name || (!headline && !avatarUrl)) {
      return NextResponse.json(
        { ok: true, patched: 0, reason: 'no enrichable fields' },
        { headers: CORS },
      );
    }

    // Find all sn: convs whose participant matches this profile (by URN or
    // exact name match) and patch the missing fields. Never overwrite a
    // non-empty value.
    const candidates = await prisma.conversation.findMany({
      where: {
        id: { startsWith: 'sn:' },
        OR: [
          { participants: { contains: p.entityUrn } },
          { participants: { contains: name } },
        ],
      },
      select: { id: true, participants: true },
    });

    let patched = 0;
    for (const c of candidates) {
      let parts: Participant[] = [];
      try { parts = JSON.parse(c.participants); } catch { continue; }
      let changed = false;
      const next = parts.map((q) => {
        if (!q) return q;
        const sameUrn = !!p.entityUrn && q.id === p.entityUrn;
        const sameName = !!q.name && q.name.toLowerCase() === name.toLowerCase();
        if (!sameUrn && !sameName) return q;
        const merged = { ...q };
        if (!q.headline && headline) { merged.headline = headline; changed = true; }
        if (!q.avatarUrl && avatarUrl) { merged.avatarUrl = avatarUrl; changed = true; }
        if (!q.name && name) { merged.name = name; changed = true; }
        return merged;
      });
      if (changed) {
        await prisma.conversation.update({
          where: { id: c.id },
          data: { participants: JSON.stringify(next) },
        });
        patched++;
      }
    }

    return NextResponse.json(
      { ok: true, patched, name, headline, avatarFound: !!avatarUrl },
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
