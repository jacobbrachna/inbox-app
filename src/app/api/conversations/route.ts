import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, safeParseArray, optionsResponse } from '@/lib/api-utils';
import type { Conversation, Enrichment, Participant } from '@/types';

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
    isGroup: row.isGroup ?? false,
    memberCount: row.memberCount ?? null,
    groupName: row.groupName ?? null,
    hasAttachments: row.hasAttachments ?? false,
    lastMessage: row.lastMessage,
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastMessageSenderId: '',
    unreadCount: row.unreadCount,
    status: row.status as Conversation['status'],
    isStarred: row.isStarred,
    snoozedUntil: row.snoozedUntil ? row.snoozedUntil.toISOString() : undefined,
    followUpAt: row.followUpAt ? row.followUpAt.toISOString() : undefined,
    followUpReason: row.followUpReason ?? null,
    followUpSource: (row.followUpSource as 'manual' | 'ai' | null) ?? null,
    followUpConfidence: (row.followUpConfidence as 'high' | 'low' | null) ?? null,
    followUpKind: (row.followUpKind as 'commitment' | 'soft' | null) ?? null,
    followUpActor: (row.followUpActor as 'self' | 'them' | 'either' | null) ?? null,
    needsReview: row.needsReview ?? false,
    notes: row.notes ?? '',
    labels: safeParseArray<string>(row.labels, []),
    aiSummary: row.aiSummary ?? null,
    enrichment,
  };
}

export async function GET() {
  const rows = await prisma.conversation.findMany({
    orderBy: { lastMessageAt: 'desc' },
    // Was 1000 — but users with bigger inboxes (1700+) silently lost their
    // oldest threads from the UI entirely, which ALSO made the "current role
    // era" filter look broken (the threads it would hide weren't even loaded).
    // Plain row select (no message include), so no SQLite param-limit concern.
    take: 20000,
  });
  const conversations = rows.map(rowToConversation);
  return NextResponse.json({ conversations }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
