import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// POST /api/ai/classify-all { force?: boolean, limit?: number }
//
// Returns the list of conversation IDs to classify. The CLIENT iterates and
// hits /api/ai/classify in chunks of 25 — that endpoint already handles
// the Claude call, batched prompt, label assignment, and review flagging.
//
// Doing this server-streaming would mean holding an HTTP request open for
// minutes; client-side chunking gives us live progress and resilience.
//
// Filter: only active conversations (last message within 365 days), not
// archived, not already classified (unless force=true).
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_DAYS = 365;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const force = body?.force === true;
    const limit = typeof body?.limit === 'number' ? Math.max(1, Math.min(2000, body.limit)) : 2000;

    const cutoff = new Date(Date.now() - ACTIVE_DAYS * DAY_MS);
    const where = force
      ? { status: { not: 'archived' }, lastMessageAt: { gte: cutoff } }
      : {
          status: { not: 'archived' },
          lastMessageAt: { gte: cutoff },
          aiSummary: null,
        };

    const convs = await prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      take: limit,
      select: { id: true },
    });

    const total = await prisma.conversation.count({
      where: { status: { not: 'archived' }, lastMessageAt: { gte: cutoff } },
    });

    return NextResponse.json(
      {
        ids: convs.map((c) => c.id),
        eligible: total,
        toClassify: convs.length,
        force,
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
