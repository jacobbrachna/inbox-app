import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// Activity metrics — the CRM heart of the app. Computes:
//   • Reply rate (outbound msgs that got a response within REPLY_WINDOW days)
//   • Avg response time (when they reply, how long after my msg)
//   • Volume sent/received
//   • Breakdown by aiCategory + by label
// All computed from messages + conv data we already have. Defaults to last 30d.

const REPLY_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ConvWithMessages {
  id: string;
  aiCategory: string | null;
  labels: string;
  messages: Array<{ sentAt: Date; isFromMe: boolean }>;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');

  const to = toParam ? new Date(toParam) : new Date();
  const from = fromParam ? new Date(fromParam) : new Date(Date.now() - 30 * DAY_MS);

  // Fetch all messages in/around the window. We pull a bit before "from" so
  // we can detect "first message in the window had a reply that fell outside".
  const allConvs: ConvWithMessages[] = await prisma.conversation.findMany({
    select: {
      id: true,
      aiCategory: true,
      labels: true,
      messages: {
        select: { sentAt: true, isFromMe: true },
        orderBy: { sentAt: 'asc' },
      },
    },
  });

  let outboundInRange = 0;
  let inboundInRange = 0;
  let outboundGotReply = 0;
  let totalResponseTimeMs = 0;
  let responseTimeSamples = 0;

  // For per-category breakdowns we want: sent count + reply rate by category
  const byCategory = new Map<string, { sent: number; replies: number }>();

  for (const c of allConvs) {
    const msgs = c.messages;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const t = m.sentAt.getTime();
      const inRange = t >= from.getTime() && t <= to.getTime();
      if (!inRange) continue;

      if (m.isFromMe) {
        outboundInRange++;
        // Did the recipient reply within REPLY_WINDOW?
        const deadline = t + REPLY_WINDOW_DAYS * DAY_MS;
        let replied = false;
        for (let j = i + 1; j < msgs.length; j++) {
          const next = msgs[j];
          if (next.sentAt.getTime() > deadline) break;
          if (!next.isFromMe) {
            replied = true;
            totalResponseTimeMs += next.sentAt.getTime() - t;
            responseTimeSamples++;
            break;
          }
        }
        if (replied) outboundGotReply++;

        const catKey = c.aiCategory ?? 'unclassified';
        const cur = byCategory.get(catKey) ?? { sent: 0, replies: 0 };
        cur.sent++;
        if (replied) cur.replies++;
        byCategory.set(catKey, cur);
      } else {
        inboundInRange++;
      }
    }
  }

  // Hot list — last message is inbound and recent (your turn)
  const hot: Array<{ id: string; lastInboundAt: string }> = [];
  // Going cold — last outbound > 3 days ago, no reply
  const goingCold: Array<{ id: string; lastOutboundAt: string; daysSince: number }> = [];
  // Awaiting first reply — outbound only, never got a reply
  let awaitingFirstReply = 0;

  for (const c of allConvs) {
    const msgs = c.messages;
    if (msgs.length === 0) continue;
    const last = msgs[msgs.length - 1];
    if (!last.isFromMe) {
      const daysSince = (Date.now() - last.sentAt.getTime()) / DAY_MS;
      if (daysSince <= 30) {
        hot.push({ id: c.id, lastInboundAt: last.sentAt.toISOString() });
      }
    } else {
      const daysSince = (Date.now() - last.sentAt.getTime()) / DAY_MS;
      if (daysSince >= 3 && daysSince <= 60) {
        goingCold.push({ id: c.id, lastOutboundAt: last.sentAt.toISOString(), daysSince: Math.floor(daysSince) });
      }
      const everInbound = msgs.some((m) => !m.isFromMe);
      if (!everInbound) awaitingFirstReply++;
    }
  }

  hot.sort((a, b) => +new Date(b.lastInboundAt) - +new Date(a.lastInboundAt));
  goingCold.sort((a, b) => a.daysSince - b.daysSince);

  const replyRate = outboundInRange > 0 ? outboundGotReply / outboundInRange : 0;
  const avgResponseTimeHours =
    responseTimeSamples > 0 ? totalResponseTimeMs / responseTimeSamples / (60 * 60 * 1000) : 0;

  const byCategoryArr = Array.from(byCategory.entries())
    .map(([category, v]) => ({
      category,
      sent: v.sent,
      replies: v.replies,
      replyRate: v.sent > 0 ? v.replies / v.sent : 0,
    }))
    .sort((a, b) => b.sent - a.sent);

  return NextResponse.json(
    {
      window: {
        from: from.toISOString(),
        to: to.toISOString(),
        days: Math.round((to.getTime() - from.getTime()) / DAY_MS),
        replyWindowDays: REPLY_WINDOW_DAYS,
      },
      totals: {
        outbound: outboundInRange,
        inbound: inboundInRange,
        replied: outboundGotReply,
        replyRate,
        avgResponseTimeHours,
      },
      byCategory: byCategoryArr,
      queues: {
        hot: hot.slice(0, 50),
        goingCold: goingCold.slice(0, 50),
        awaitingFirstReply,
      },
    },
    { headers: CORS },
  );
}

export async function OPTIONS() {
  return optionsResponse();
}
