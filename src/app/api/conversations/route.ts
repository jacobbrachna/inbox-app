import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, safeParseArray, optionsResponse } from '@/lib/api-utils';
import type { AiCategory, Conversation, Enrichment, Participant } from '@/types';

type ConversationRow = Awaited<ReturnType<typeof prisma.conversation.findFirstOrThrow>>;

function rowToConversation(row: ConversationRow): Conversation {
  let enrichment: Enrichment | null = null;
  if (row.enrichment) {
    try { enrichment = JSON.parse(row.enrichment) as Enrichment; } catch {}
  }
  return {
    id: row.id,
    source: row.source as Conversation['source'],
    participants: safeParseArray<Participant>(row.participants, []),
    lastMessage: row.lastMessage,
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastMessageSenderId: '',
    unreadCount: row.unreadCount,
    status: row.status as Conversation['status'],
    isStarred: row.isStarred,
    snoozedUntil: row.snoozedUntil ? row.snoozedUntil.toISOString() : undefined,
    followUpAt: row.followUpAt ? row.followUpAt.toISOString() : undefined,
    notes: row.notes ?? '',
    labels: safeParseArray<string>(row.labels, []),
    aiCategory: (row.aiCategory as AiCategory | null) ?? null,
    aiSummary: row.aiSummary ?? null,
    enrichment,
  };
}

export async function GET() {
  const rows = await prisma.conversation.findMany({
    orderBy: { lastMessageAt: 'desc' },
    take: 1000,
  });
  const conversations = rows.map(rowToConversation);
  return NextResponse.json({ conversations }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
