import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// POST { urns: string[] } — list of fs_salesProfile URNs.
// Returns { needed: string[] } — the subset that still needs headline
// enrichment (no participant in any sn: conv has this URN with a non-empty
// headline). Used by Phase 3 to skip already-enriched contacts.

type Participant = { id?: string; headline?: string };

export async function POST(req: NextRequest) {
  try {
    const { urns } = await req.json();
    if (!Array.isArray(urns)) {
      return NextResponse.json({ error: 'urns array required' }, { status: 400, headers: CORS });
    }
    const incoming = new Set<string>(urns.filter((u) => typeof u === 'string'));
    if (incoming.size === 0) {
      return NextResponse.json({ needed: [] }, { headers: CORS });
    }

    // Pull all sn: convs once; build a set of URNs that already have a headline
    const rows = await prisma.conversation.findMany({
      where: { id: { startsWith: 'sn:' } },
      select: { participants: true },
    });
    const haveHeadline = new Set<string>();
    for (const r of rows) {
      let parts: Participant[] = [];
      try { parts = JSON.parse(r.participants); } catch { continue; }
      for (const p of parts) {
        if (p?.id && p?.headline && p.headline.trim().length > 0) {
          haveHeadline.add(p.id);
        }
      }
    }

    const needed: string[] = [];
    for (const u of incoming) {
      if (!haveHeadline.has(u)) needed.push(u);
    }
    return NextResponse.json(
      { needed, skipped: incoming.size - needed.length, totalIncoming: incoming.size },
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
