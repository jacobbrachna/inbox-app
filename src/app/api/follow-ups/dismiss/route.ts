import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// POST /api/follow-ups/dismiss
// Body: { conversationId, phrase?, kind? }
//
// User says "this follow-up is wrong" on a thread. We:
//   1. Record the trigger phrase to FollowUpFeedback so future classify
//      runs can include it as a "don't trigger on this kind of phrasing" hint
//   2. Clear the follow-up from the Conversation row
//
// Only AI-source follow-ups are dismissable via this path. Manual follow-ups
// stay (the user can clear those via the regular date picker → Clear button).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const conversationId = String(body?.conversationId ?? '').trim();
    if (!conversationId) {
      return NextResponse.json({ error: 'conversationId required' }, { status: 400, headers: CORS });
    }

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { followUpReason: true, followUpKind: true, followUpSource: true },
    });
    if (!conv) {
      return NextResponse.json({ error: 'conversation not found' }, { status: 404, headers: CORS });
    }
    if (conv.followUpSource !== 'ai') {
      return NextResponse.json({ error: 'only AI follow-ups dismissable here' }, { status: 400, headers: CORS });
    }

    const phrase = typeof body?.phrase === 'string' && body.phrase.trim()
      ? body.phrase.trim()
      : (conv.followUpReason ?? '(unknown phrase)');
    const kind = typeof body?.kind === 'string' ? body.kind : (conv.followUpKind ?? null);

    await prisma.followUpFeedback.create({
      data: { conversationId, phrase: phrase.slice(0, 240), kind },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        followUpAt: null,
        followUpSource: null,
        followUpReason: null,
        followUpConfidence: null,
        followUpKind: null,
        followUpActor: null,
      },
    });

    return NextResponse.json({ ok: true }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
