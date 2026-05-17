import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET /api/conversations/find-by-recipient?urn=<linkedinUrn>&source=linkedin|sales_nav
// Used by the new-thread composer: when user picks a recipient, we look up
// whether they already have a conversation with that person on the chosen
// channel. If yes, the composer redirects them into the existing thread
// instead of creating a duplicate.
//
// Match strategy: any active (non-draft) conversation whose first participant's
// id matches the supplied URN AND whose source matches the channel. Drafts
// are excluded because they're not "real" threads yet.
export async function GET(req: NextRequest) {
  const urn = req.nextUrl.searchParams.get('urn') ?? '';
  const source = req.nextUrl.searchParams.get('source');
  if (!urn || !source) {
    return NextResponse.json({ conversation: null }, { headers: CORS });
  }
  if (source !== 'linkedin' && source !== 'sales_nav') {
    return NextResponse.json({ error: 'source must be linkedin|sales_nav' }, { status: 400, headers: CORS });
  }

  // Participants is a JSON string in DB — we need a substring match on the
  // URN. The first participant is what matters (1:1 threads), but URN-in-JSON
  // catches group threads too (still valid surfacing).
  const candidates = await prisma.conversation.findMany({
    where: {
      source,
      status: { not: 'draft' },
      participants: { contains: urn },
    },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true, lastMessageAt: true },
    take: 5,
  });
  if (candidates.length === 0) {
    return NextResponse.json({ conversation: null }, { headers: CORS });
  }
  // Most recently active thread wins.
  return NextResponse.json({ conversation: candidates[0] }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
