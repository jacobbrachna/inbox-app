import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, safeParseArray, optionsResponse } from '@/lib/api-utils';
import type { Participant } from '@/types';

// PUT { enrichment: {...} } — store profile enrichment fetched by the extension.
// The extension drives the LinkedIn fetch (it has the auth context) and POSTs
// the cleaned result here. If the enrichment carries a resolved profileUrl
// we also patch it onto the primary participant so the "View profile" link
// works for this conversation.
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const enrichment = body?.enrichment;
    if (!enrichment || typeof enrichment !== 'object') {
      return NextResponse.json({ error: 'enrichment object required' }, { status: 400, headers: CORS });
    }

    const conv = await prisma.conversation.findUnique({ where: { id } });
    if (!conv) {
      return NextResponse.json({ error: 'conversation not found' }, { status: 404, headers: CORS });
    }

    let participantsJson = conv.participants;
    const resolvedUrl = typeof enrichment.profileUrl === 'string' ? enrichment.profileUrl : '';
    if (resolvedUrl) {
      const parts = safeParseArray<Participant>(conv.participants, []);
      if (parts.length > 0 && !parts[0].profileUrl) {
        parts[0] = { ...parts[0], profileUrl: resolvedUrl };
        participantsJson = JSON.stringify(parts);
      }
    }

    await prisma.conversation.update({
      where: { id },
      data: {
        enrichment: JSON.stringify(enrichment),
        enrichmentAt: new Date(),
        ...(participantsJson !== conv.participants ? { participants: participantsJson } : {}),
      },
    });
    return NextResponse.json({ ok: true }, { headers: CORS });
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
