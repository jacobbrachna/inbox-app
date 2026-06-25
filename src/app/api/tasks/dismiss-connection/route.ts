import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// POST { contactId, undo? } → soft-hide (or un-hide) a contact from the
// Tasks → New Connections list. Dismiss is purely a UI flag: the contact
// row and all its data stay intact, and sending a first message still moves
// them off the list on its own (via lastOutboundAt). undo:true clears it.
export async function POST(req: NextRequest) {
  try {
    const { contactId, undo } = await req.json();
    if (typeof contactId !== 'string' || !contactId) {
      return NextResponse.json({ error: 'contactId required' }, { status: 400, headers: CORS });
    }
    await prisma.contact.update({
      where: { id: contactId },
      data: { tasksDismissedAt: undo ? null : new Date() },
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
