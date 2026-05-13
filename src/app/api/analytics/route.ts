import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { safeParseArray } from '@/lib/api-utils';

// GET /api/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD
// Both optional. Without them, returns all-time stats.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const fromStr = searchParams.get('from');
  const toStr = searchParams.get('to');

  const from = fromStr ? new Date(fromStr) : null;
  // Inclusive end-of-day for `to`
  const to = toStr
    ? new Date(new Date(toStr).getTime() + 86_400_000 - 1)
    : null;

  const inRange = (d: Date) => {
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  };

  const [conversations, allMessages, appState] = await Promise.all([
    prisma.conversation.findMany({
      select: { id: true, status: true, isStarred: true, lastMessageAt: true, labels: true },
    }),
    prisma.message.findMany({
      select: { id: true, conversationId: true, isFromMe: true, sentAt: true },
      orderBy: { sentAt: 'asc' },
    }),
    prisma.appState.findUnique({ where: { id: 1 } }),
  ]);

  // Messages filtered by range
  const messages = (from || to) ? allMessages.filter((m) => inRange(m.sentAt)) : allMessages;

  // Conversations that had activity within the range (or all if no range)
  const activeConvIdsInRange = new Set(messages.map((m) => m.conversationId));
  const rangeConversations = (from || to)
    ? conversations.filter((c) => activeConvIdsInRange.has(c.id) || inRange(c.lastMessageAt))
    : conversations;

  // ── Basic counts (these are point-in-time totals — always all-time)
  const totalConversations = conversations.length;
  const unreadCount = conversations.filter((c) => c.status === 'unread').length;
  const starredCount = conversations.filter((c) => c.isStarred).length;
  const archivedCount = conversations.filter((c) => c.status === 'archived').length;

  // ── Range-aware totals
  const conversationsInRange = rangeConversations.length;
  const totalMessages = messages.length;
  const sent = messages.filter((m) => m.isFromMe).length;
  const received = messages.filter((m) => !m.isFromMe).length;

  // ── Group messages by conversation for cohort analysis
  const byConv = new Map<string, typeof messages>();
  for (const m of messages) {
    if (!byConv.has(m.conversationId)) byConv.set(m.conversationId, []);
    byConv.get(m.conversationId)!.push(m);
  }

  // ── Response rate: convos where the first message in range is from me
  let coldOutbound = 0;
  let coldReplied = 0;
  for (const arr of byConv.values()) {
    if (arr.length === 0) continue;
    if (arr[0].isFromMe) {
      coldOutbound++;
      if (arr.some((m) => !m.isFromMe)) coldReplied++;
    }
  }
  const responseRate = coldOutbound > 0 ? coldReplied / coldOutbound : 0;

  // ── Avg time to my reply
  let totalReplyMs = 0;
  let replyCount = 0;
  for (const arr of byConv.values()) {
    for (let i = 0; i < arr.length - 1; i++) {
      const cur = arr[i];
      const next = arr[i + 1];
      if (!cur.isFromMe && next.isFromMe) {
        totalReplyMs += next.sentAt.getTime() - cur.sentAt.getTime();
        replyCount++;
      }
    }
  }
  const avgReplyMs = replyCount > 0 ? totalReplyMs / replyCount : 0;

  // ── Daily volume — bucket span matches the requested range
  // If no range: default to last 30 days
  const now = Date.now();
  const rangeStart = from ? from.getTime() : now - 29 * 86_400_000;
  const rangeEnd = to ? to.getTime() : now;
  const dayCount = Math.max(1, Math.ceil((rangeEnd - rangeStart) / 86_400_000));
  const dayBuckets: Record<string, { sent: number; received: number }> = {};
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(rangeStart + i * 86_400_000).toISOString().slice(0, 10);
    dayBuckets[d] = { sent: 0, received: 0 };
  }
  for (const m of messages) {
    const day = m.sentAt.toISOString().slice(0, 10);
    if (!dayBuckets[day]) continue;
    if (m.isFromMe) dayBuckets[day].sent++;
    else dayBuckets[day].received++;
  }
  const dailyVolume = Object.entries(dayBuckets)
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // ── Label counts for range conversations
  const labelCounts: Record<string, number> = {};
  for (const c of rangeConversations) {
    const labels = safeParseArray<string>(c.labels);
    for (const l of labels) labelCounts[l] = (labelCounts[l] ?? 0) + 1;
  }

  return NextResponse.json({
    range: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
    // Point-in-time counts (always all-time)
    totalConversations,
    unreadCount,
    starredCount,
    archivedCount,
    // Range-aware
    conversationsInRange,
    totalMessages,
    sent,
    received,
    responseRate,
    coldOutbound,
    coldReplied,
    avgReplyMs,
    avgReplyHours: avgReplyMs > 0 ? avgReplyMs / 3_600_000 : 0,
    dailyVolume,
    labelCounts,
    lastSyncedAt: appState?.lastSyncedAt,
  });
}
