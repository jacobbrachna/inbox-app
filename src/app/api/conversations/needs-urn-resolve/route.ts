import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, safeParseArray, optionsResponse } from '@/lib/api-utils';
import type { Participant } from '@/types';

// GET ?limit=10 → { items: [{ id, participantUrn }] }
//
// Surfaces conversations whose primary participant has the "LinkedIn User"
// placeholder name AND a valid fsd_profile URN. The needs-profile-fetch
// flow requires a profileUrl (so it can open a tab to scrape) — but when
// a conv comes in through the 10s incremental poll, voyager often returns
// just the participant URN with no entity, leaving us with no profileUrl
// and no real name. This endpoint catches those and lets the extension
// resolve the URN via /voyager/api/identity/dash/profiles?q=memberIdentity.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') ?? '10', 10)));

  const rows = await prisma.conversation.findMany({
    where: { status: { not: 'archived' } },
    select: { id: true, participants: true },
    orderBy: { lastMessageAt: 'desc' },
    take: 500, // sample widely; filter in JS
  });

  const items: Array<{ id: string; participantUrn: string }> = [];
  for (const r of rows) {
    if (items.length >= limit) break;
    const parts = safeParseArray<Participant>(r.participants, []);
    const p = parts[0];
    if (!p) continue;
    // Only convs where the name is still the placeholder AND we have a URN
    // to resolve from. fsd_profile URNs are the LinkedIn-side IDs.
    if (p.name && p.name !== 'LinkedIn User') continue;
    if (typeof p.id !== 'string' || !p.id.includes('fsd_profile')) continue;
    items.push({ id: r.id, participantUrn: p.id });
  }

  return NextResponse.json({ items }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
