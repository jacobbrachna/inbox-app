import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

export async function GET() {
  const [convCount, msgCount, unread, archived, starred, withNotes, withFollowUp, labelCount, snippetCount, appState] = await Promise.all([
    prisma.conversation.count(),
    prisma.message.count(),
    prisma.conversation.count({ where: { status: 'unread' } }),
    prisma.conversation.count({ where: { status: 'archived' } }),
    prisma.conversation.count({ where: { isStarred: true } }),
    prisma.conversation.count({ where: { notes: { not: '' } } }),
    prisma.conversation.count({ where: { followUpAt: { not: null } } }),
    prisma.label.count(),
    prisma.snippet.count(),
    prisma.appState.findUnique({ where: { id: 1 } }),
  ]);

  // Conversations with empty preview but having messages — likely a sync bug.
  // SQLite returns COUNT(*) as BigInt under newer Prisma — coerce to Number
  // so NextResponse.json can serialize it.
  const orphanedPreviews = await prisma.$queryRaw<{ cnt: bigint | number }[]>`
    SELECT COUNT(*) as cnt
    FROM Conversation c
    WHERE (c.lastMessage IS NULL OR c.lastMessage = '')
      AND EXISTS (SELECT 1 FROM Message m WHERE m.conversationId = c.id)
  `;

  // Conversations with no participants (display data issues)
  const emptyParticipants = await prisma.$queryRaw<{ cnt: bigint | number }[]>`
    SELECT COUNT(*) as cnt FROM Conversation WHERE participants = '[]' OR participants IS NULL
  `;

  return NextResponse.json({
    convCount,
    msgCount,
    unread,
    archived,
    starred,
    withNotes,
    withFollowUp,
    labelCount,
    snippetCount,
    orphanedPreviews: Number(orphanedPreviews[0]?.cnt ?? 0),
    emptyParticipants: Number(emptyParticipants[0]?.cnt ?? 0),
    appState: {
      myProfileUrn: appState?.myProfileUrn ?? null,
      profileName: appState?.profileName ?? null,
      lastSyncedAt: appState?.lastSyncedAt ?? null,
    },
  }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
