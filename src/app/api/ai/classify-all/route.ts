import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// POST /api/ai/classify-all { force?: boolean, limit?: number, source?: 'all'|'linkedin'|'sn' }
//
// Returns the list of conversation IDs to classify. The CLIENT iterates and
// hits /api/ai/classify in chunks of 25 — that endpoint already handles
// the Claude call, batched prompt, label assignment, and review flagging.
//
// Doing this server-streaming would mean holding an HTTP request open for
// minutes; client-side chunking gives us live progress and resilience.
//
// Filter: only active conversations (last message within 365 days), not
// archived, not already classified (unless force=true). Optional source
// filter narrows to LinkedIn (msg_conversation URN) or Sales Nav (sn: prefix).
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_DAYS = 365;

// SN convs use ids starting with "sn:"; everything else (msg_conversation
// URNs, draft URLs, etc.) is treated as LinkedIn for this filter.
function sourceFilter(source: string) {
  if (source === 'sn') return { id: { startsWith: 'sn:' } };
  if (source === 'linkedin') return { id: { not: { startsWith: 'sn:' } } };
  return {};
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const force = body?.force === true;
    const limit = typeof body?.limit === 'number' ? Math.max(1, Math.min(2000, body.limit)) : 2000;
    const source = typeof body?.source === 'string' ? body.source : 'all';

    const cutoff = new Date(Date.now() - ACTIVE_DAYS * DAY_MS);
    const base = {
      status: { not: 'archived' },
      lastMessageAt: { gte: cutoff },
      ...sourceFilter(source),
    };
    const where = force ? base : { ...base, aiSummary: null };

    const convs = await prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      take: limit,
      select: { id: true },
    });

    const total = await prisma.conversation.count({ where: base });

    return NextResponse.json(
      {
        ids: convs.map((c: { id: string }) => c.id),
        eligible: total,
        toClassify: convs.length,
        force,
        source,
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

// GET /api/ai/classify-all — lightweight count of pending classifications.
// Used by the Diagnostics button to show "~N min for X conversations"
// before the user commits to a run.
export async function GET() {
  const cutoff = new Date(Date.now() - ACTIVE_DAYS * DAY_MS);
  const eligible = await prisma.conversation.count({
    where: { status: { not: 'archived' }, lastMessageAt: { gte: cutoff } },
  });
  const pending = await prisma.conversation.count({
    where: {
      status: { not: 'archived' },
      lastMessageAt: { gte: cutoff },
      aiSummary: null,
    },
  });
  return NextResponse.json({ eligible, pending }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
