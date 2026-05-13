import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// SQLite is the source of truth. Project the conversation index for the
// extension's incremental-sync check.
export async function GET() {
  const rows = await prisma.conversation.findMany({
    select: { id: true, lastMessageAt: true },
  });
  const conversationsByUrn: Record<string, number> = {};
  for (const r of rows) conversationsByUrn[r.id] = r.lastMessageAt.getTime();

  const appState = await prisma.appState.findUnique({ where: { id: 1 } }).catch(() => null);
  const lastSyncedAt = appState?.lastSyncedAt ? appState.lastSyncedAt.getTime() : 0;
  const myProfileUrn = appState?.myProfileUrn ?? '';
  const profileName = appState?.profileName ?? '';

  return NextResponse.json(
    { conversationsByUrn, lastSyncedAt, myProfileUrn, profileName },
    { headers: CORS },
  );
}

export async function OPTIONS() {
  return optionsResponse();
}
