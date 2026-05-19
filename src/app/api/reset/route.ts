import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// Wipes all conversations + messages from the DB. Keeps labels, snippets,
// AppState (so myProfileUrn / profileName survives a reset) — unless
// `resetProfile=1` is passed, which also clears the identity fields so the
// next sync re-bootstraps from /voyager/api/me. Used by the account-mismatch
// flow when switching LinkedIn accounts.
// Requires confirm=YES query param to avoid accidental triggers.
export async function POST(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('confirm') !== 'YES') {
    return NextResponse.json(
      { error: 'Refusing to reset without confirm=YES' },
      { status: 400, headers: CORS },
    );
  }
  const resetProfile = url.searchParams.get('resetProfile') === '1';

  // Cascade delete is configured on Message → Conversation. Deleting
  // conversations removes all messages automatically.
  const ops: Parameters<typeof prisma.$transaction>[0] = [
    prisma.message.deleteMany({}),
    prisma.conversation.deleteMany({}),
  ];
  if (resetProfile) {
    ops.push(
      prisma.appState.update({
        where: { id: 1 },
        data: { myProfileUrn: '', profileName: '' },
      }),
    );
  }
  const results = await prisma.$transaction(ops);
  const msgsDeleted = results[0] as { count: number };
  const convsDeleted = results[1] as { count: number };

  return NextResponse.json(
    {
      ok: true,
      messagesDeleted: msgsDeleted.count,
      conversationsDeleted: convsDeleted.count,
      profileReset: resetProfile,
    },
    { headers: CORS },
  );
}

export async function OPTIONS() {
  return optionsResponse();
}
