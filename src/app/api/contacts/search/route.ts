import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET /api/contacts/search?q=<query>&channel=linkedin|sn
// Typeahead for the new-thread composer. Tokenizes the query and matches
// against name / headline / company / role — so "jacob bedrock" finds
// Jacob at Bedrock, "vp eng" finds VPs of Engineering, etc.
//
// Ranking happens in JS over a broader candidate set so we can prefer
// strong-signal matches (full-query prefix on name) over weak ones (token
// in a headline). Channel filter still requires linkedinUrn.
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  const channel = req.nextUrl.searchParams.get('channel');
  if (q.length < 2) return NextResponse.json({ contacts: [] }, { headers: CORS });

  // Tokenize. Cap tokens so a pathological query doesn't blow up the AND clause.
  const tokens = q.split(/\s+/).filter((t) => t.length > 0).slice(0, 5);

  const where: Record<string, unknown> = {
    AND: tokens.map((t) => ({
      OR: [
        { name: { contains: t } },
        { headline: { contains: t } },
        { company: { contains: t } },
        { role: { contains: t } },
      ],
    })),
    NOT: {
      AND: [
        { name: { in: ['LinkedIn User', 'LinkedIn Member'] } },
        { linkedinUrn: null },
        { profileSlug: null },
      ],
    },
  };
  if (channel === 'linkedin' || channel === 'sn') {
    where.linkedinUrn = { not: null };
  }

  // Pull a broader candidate pool than we return — ranking surfaces the
  // best 20 of these.
  const rows = await prisma.contact.findMany({
    where,
    take: 80,
    orderBy: [{ lastSeenAt: 'desc' }],
    select: {
      id: true,
      name: true,
      headline: true,
      company: true,
      role: true,
      avatarUrl: true,
      linkedinUrn: true,
      profileSlug: true,
      profileUrl: true,
      lastSeenAt: true,
    },
  });

  // Score each row. Higher = better match.
  //   • Full query as prefix on name → strongest signal
  //   • Full query as substring on name → strong
  //   • Each token: name-start > name-middle > headline/company > role
  // Tiebreak by lastSeenAt desc (most recently touched contact wins).
  const qLower = q.toLowerCase();
  const tokensLower = tokens.map((t) => t.toLowerCase());
  function score(c: { name: string; headline: string | null; company: string | null; role: string | null }): number {
    const name = (c.name || '').toLowerCase();
    const hl = (c.headline || '').toLowerCase();
    const co = (c.company || '').toLowerCase();
    const ro = (c.role || '').toLowerCase();
    let s = 0;
    if (name.startsWith(qLower)) s += 25;
    else if (name.includes(qLower)) s += 15;
    for (const t of tokensLower) {
      if (name.startsWith(t)) s += 10;
      else if (name.includes(' ' + t)) s += 7;
      else if (name.includes(t)) s += 4;
      if (co.includes(t)) s += 4;
      if (hl.includes(t)) s += 2;
      if (ro.includes(t)) s += 2;
    }
    return s;
  }

  const ranked = rows
    .map((r) => ({ row: r, s: score(r) }))
    .sort((a, b) => {
      if (b.s !== a.s) return b.s - a.s;
      const at = a.row.lastSeenAt ? new Date(a.row.lastSeenAt).getTime() : 0;
      const bt = b.row.lastSeenAt ? new Date(b.row.lastSeenAt).getTime() : 0;
      return bt - at;
    })
    .slice(0, 20)
    .map(({ row }) => {
      // Strip lastSeenAt from the response — purely an internal sort key.
      const { lastSeenAt: _omit, ...rest } = row;
      void _omit;
      return rest;
    });

  return NextResponse.json({ contacts: ranked }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
