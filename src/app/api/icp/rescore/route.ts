import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse, safeParseArray } from '@/lib/api-utils';
import { parseIcpDefinition, scoreIcp } from '@/lib/icp-score';
import type { Participant } from '@/types';

// POST /api/icp/rescore  → { updated, total }
//
// Runs the deterministic ICP scorer over every non-archived conversation,
// writing `aiIcpFit` per row. Fast (no Claude calls), idempotent. Triggered
// from the ICP Builder UI when the user clicks "Re-score all" or after a
// fresh build.
export async function POST() {
  const state = await prisma.appState.findUnique({ where: { id: 1 } });
  const def = parseIcpDefinition(state?.icpDefinition);
  if (!def) {
    return NextResponse.json(
      { error: 'No icpDefinition — build one first via /api/icp/build' },
      { status: 400, headers: CORS },
    );
  }

  // Pull all non-archived convs. We only need participants + enrichment to
  // score — small select keeps the query light at scale.
  const convs = await prisma.conversation.findMany({
    where: { status: { not: 'archived' } },
    select: { id: true, participants: true, enrichment: true },
  });

  let updated = 0;
  // Update in chunks to avoid per-row Prisma overhead.
  for (const c of convs) {
    const parts = safeParseArray<Participant>(c.participants, []);
    const p = parts[0];
    let enrichment: { company?: string; role?: string; about?: string } | null = null;
    if (c.enrichment) {
      try { enrichment = JSON.parse(c.enrichment); } catch {}
    }
    const breakdown = scoreIcp({
      headline: p?.headline ?? null,
      role: enrichment?.role ?? null,
      about: enrichment?.about ?? null,
      company: enrichment?.company ?? null,
    }, def);
    await prisma.conversation.update({
      where: { id: c.id },
      data: { aiIcpFit: breakdown.fit },
    });
    updated++;
  }

  return NextResponse.json({ updated, total: convs.length }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
