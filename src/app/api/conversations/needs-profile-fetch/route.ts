import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, safeParseArray, optionsResponse } from '@/lib/api-utils';
import type { Participant } from '@/types';

// GET ?limit=3 → { items: [{ id, profileUrl }] }
//
// Returns conversations that:
//   • have a profileUrl on their primary participant (so we know where to fetch)
//   • are missing company OR role in enrichment (worth enriching)
//   • haven't been enrichment-touched in the last 7 days (don't churn)
//   • aren't archived
// Ordered by lastMessageAt desc — fetch recently-active contacts first.
// The background worker uses this list to know which profiles to silently visit.
const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') ?? '3', 10)));

  const rows = await prisma.conversation.findMany({
    where: {
      status: { not: 'archived' },
      OR: [
        { enrichmentAt: null },
        { enrichmentAt: { lt: new Date(Date.now() - 7 * DAY_MS) } },
      ],
    },
    select: { id: true, participants: true, enrichment: true },
    orderBy: { lastMessageAt: 'desc' },
    take: 500, // sample widely, filter in JS
  });

  const items: Array<{ id: string; profileUrl: string }> = [];
  for (const r of rows) {
    if (items.length >= limit) break;
    const parts = safeParseArray<Participant>(r.participants, []);
    const p = parts[0];
    if (!p?.profileUrl) continue;

    let enr: Record<string, unknown> = {};
    if (r.enrichment) {
      try { enr = JSON.parse(r.enrichment); } catch {}
    }
    // Skip if already has BOTH company + role — fully enriched
    if (typeof enr.company === 'string' && typeof enr.role === 'string') continue;

    items.push({ id: r.id, profileUrl: p.profileUrl });
  }

  return NextResponse.json({ items }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
