import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// Wipes all conversations + messages from the DB. Keeps labels, snippets,
// AppState (so myProfileUrn / profileName survives a reset).
// Requires confirm=YES query param to avoid accidental triggers.
export async function POST(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('confirm') !== 'YES') {
    return NextResponse.json(
      { error: 'Refusing to reset without confirm=YES' },
      { status: 400, headers: CORS },
    );
  }

  // Cascade delete is configured on Message → Conversation. Deleting
  // conversations removes all messages automatically.
  const [msgsDeleted, convsDeleted] = await prisma.$transaction([
    prisma.message.deleteMany({}),
    prisma.conversation.deleteMany({}),
  ]);

  return NextResponse.json(
    { ok: true, messagesDeleted: msgsDeleted.count, conversationsDeleted: convsDeleted.count },
    { headers: CORS },
  );
}

export async function OPTIONS() {
  return optionsResponse();
}
