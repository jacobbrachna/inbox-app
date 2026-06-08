import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, safeParseArray, optionsResponse } from '@/lib/api-utils';
import type { Participant } from '@/types';

// Outbound queue — the "what to work on today" list. Five surfaces:
//   • topPriority — AI-curated, highest priority across all buckets
//   • hot         — they replied, your turn (last msg is inbound)
//   • overdue     — followUpAt is in the past
//   • goingCold   — sent 3+ days ago, no reply
//   • stale       — had at least one inbound reply ever, but silent 30+ days

const DAY_MS = 24 * 60 * 60 * 1000;

function loadPage(ids: string[]) {
  return prisma.conversation.findMany({
    where: { id: { in: ids } },
    include: {
      messages: {
        select: { sentAt: true, isFromMe: true },
        orderBy: { sentAt: 'desc' },
        take: 1,
      },
      _count: {
        select: { messages: { where: { isFromMe: false } } },
      },
    },
  });
}

interface QueueItem {
  id: string;
  name: string;
  headline: string;
  company: string | null;
  avatarUrl: string | null;
  lastMessageAt: string;
  reason: string;
  daysSince: number;
  // AI fields populated by /api/queue/score-batch
  aiScore: number | null;
  aiSignal: string | null;
  // ICP fit — 0-100 from Claude, OR 100 when manualIcp override is on.
  // `isIcp` is a derived boolean (icpFit >= 60 OR manual override).
  icpFit: number | null;
  isIcp: boolean;
  manualIcp: boolean;
  snoozedUntil: string | null;
  labels: string[];
}

// ICP cutoff: anything ≥ this counts as ICP. Tuned to "close fits and clear
// matches in, weak fits out." Adjustable later if Claude's scoring drifts.
const ICP_THRESHOLD = 60;

// Terminal / handled states — drop these from the worklist entirely. You've
// already met (meeting-done), it's dead (not-interested / ghosted / spam), or
// it's an active deal handled off-LinkedIn (in-deal, user-applied for POVs/
// customers). They clutter the queue and aren't actionable cold-follow-ups.
const TERMINAL_LABELS = new Set([
  'not-interested', 'ai-spam', 'ai-ghosted', 'ai-meeting-done', 'in-deal',
]);

export async function GET(req: NextRequest) {
  const now = Date.now();
  const { searchParams } = new URL(req.url);
  // Default view hides dismissed + snoozed-future items. Toggleable from UI.
  const showHidden = searchParams.get('showHidden') === '1';
  // Optional strict mode — drops non-ICP-fit items entirely.
  const onlyIcp = searchParams.get('onlyIcp') === '1';
  // Global "current role era" filter — only threads with activity since the
  // user's current role started (mirrors the inbox toggle).
  const roleStartParam = searchParams.get('roleStart');
  const roleStart = roleStartParam ? new Date(roleStartParam) : null;
  const roleStartValid = roleStart && !Number.isNaN(roleStart.getTime()) ? roleStart : null;

  // Page through to stay under SQLite's 999-param limit on the message
  // include + _count subquery.
  const convIds = await prisma.conversation.findMany({
    where: {
      status: { not: 'archived' },
      ...(roleStartValid ? { lastMessageAt: { gte: roleStartValid } } : {}),
      ...(showHidden ? {} : {
        queueDismissed: false,
        OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date(now) } }],
      }),
    },
    select: { id: true },
    orderBy: { lastMessageAt: 'desc' },
  });
  const convs: Awaited<ReturnType<typeof loadPage>> = [];
  const PAGE = 100;
  for (let i = 0; i < convIds.length; i += PAGE) {
    const slice = convIds.slice(i, i + PAGE).map((c) => c.id);
    const page = await loadPage(slice);
    convs.push(...page);
  }

  const hot: QueueItem[] = [];
  const overdue: QueueItem[] = [];
  const goingCold: QueueItem[] = [];
  const stale: QueueItem[] = [];

  for (const c of convs) {
    // Drop terminal / handled states (met, dead, or active deal) from the queue.
    const convLabels = safeParseArray<string>(c.labels, []);
    if (convLabels.some((l) => TERMINAL_LABELS.has(l))) continue;

    const parts = safeParseArray<Participant>(c.participants, []);
    const p = parts[0];
    let enrichment: { company?: string } | null = null;
    if (c.enrichment) {
      try { enrichment = JSON.parse(c.enrichment); } catch {}
    }
    // Derived ICP boolean: manual override OR Claude's fit ≥ threshold.
    const icpFit = c.aiIcpFit ?? null;
    const manualIcp = c.manualIcp ?? false;
    const isIcp = manualIcp || (icpFit !== null && icpFit >= ICP_THRESHOLD);
    const base: Omit<QueueItem, 'reason' | 'daysSince'> = {
      id: c.id,
      name: p?.name ?? 'Unknown',
      headline: p?.headline ?? '',
      company: enrichment?.company ?? null,
      avatarUrl: p?.avatarUrl ?? null,
      lastMessageAt: c.lastMessageAt.toISOString(),
      aiScore: c.aiPriorityScore ?? null,
      aiSignal: c.aiPrioritySignal ?? null,
      icpFit,
      isIcp,
      manualIcp,
      snoozedUntil: c.snoozedUntil ? c.snoozedUntil.toISOString() : null,
      labels: convLabels,
    };

    const last = c.messages[0];
    const daysSinceLast = last ? (now - last.sentAt.getTime()) / DAY_MS : Infinity;
    const inboundReplyCount = c._count.messages;

    // Overdue follow-up takes precedence — explicit user commitment
    if (c.followUpAt && c.followUpAt.getTime() < now) {
      const daysOverdue = Math.floor((now - c.followUpAt.getTime()) / DAY_MS);
      overdue.push({
        ...base,
        reason: c.aiPrioritySignal
          || (daysOverdue === 0 ? 'Follow-up due today' : `${daysOverdue}d overdue`),
        daysSince: daysOverdue,
      });
      continue;
    }

    if (!last) continue;

    // Hot — they sent the last message, ≤30 days ago
    if (!last.isFromMe && daysSinceLast <= 30) {
      hot.push({
        ...base,
        reason: c.aiPrioritySignal
          || (daysSinceLast < 1 ? 'Replied today' : `Replied ${Math.floor(daysSinceLast)}d ago`),
        daysSince: Math.floor(daysSinceLast),
      });
      continue;
    }

    // Going cold — I sent the last message, 3+ days ago, no reply (no upper bound)
    if (last.isFromMe && daysSinceLast >= 3 && daysSinceLast < 30) {
      goingCold.push({
        ...base,
        reason: c.aiPrioritySignal
          || `Sent ${Math.floor(daysSinceLast)}d ago, no reply`,
        daysSince: Math.floor(daysSinceLast),
      });
      continue;
    }

    // Stale — had at least one real reply, but quiet 30+ days.
    if (inboundReplyCount > 0 && daysSinceLast >= 30) {
      stale.push({
        ...base,
        reason: c.aiPrioritySignal
          || `Last touch ${Math.floor(daysSinceLast)}d ago`,
        daysSince: Math.floor(daysSinceLast),
      });
    }
  }

  // Sort within each bucket. ICP fits float to the top; within ICP and within
  // non-ICP, AI priority + daysSince do the secondary ordering. Overdue keeps
  // its own ordering because deadlines win over ICP fit when something's
  // already past due.
  const icpFirst = (a: QueueItem, b: QueueItem) => Number(b.isIcp) - Number(a.isIcp);
  hot.sort((a, b) => icpFirst(a, b) || (b.aiScore ?? -1) - (a.aiScore ?? -1) || a.daysSince - b.daysSince);
  overdue.sort((a, b) => b.daysSince - a.daysSince);
  goingCold.sort((a, b) => icpFirst(a, b) || (b.aiScore ?? -1) - (a.aiScore ?? -1) || a.daysSince - b.daysSince);
  stale.sort((a, b) => icpFirst(a, b) || (b.aiScore ?? -1) - (a.aiScore ?? -1) || b.daysSince - a.daysSince);

  // Strict mode — when "Only ICP fits" toggle is on, drop non-fit items from
  // the regular buckets entirely. Manual-ICP rows always survive.
  if (onlyIcp) {
    for (const arr of [hot, goingCold, stale, overdue]) {
      const filtered = arr.filter((it) => it.isIcp);
      arr.length = 0;
      arr.push(...filtered);
    }
  }

  // Top Priority — across-bucket pick. Take any item with AI score >= 70.
  // Cap at 10; sorted by score desc.
  const allScored = [...hot, ...overdue, ...goingCold, ...stale]
    .filter((it) => typeof it.aiScore === 'number' && it.aiScore >= 70);
  // Dedup by id (an item might appear in multiple sources — currently buckets
  // are mutually exclusive but defensive)
  const seen = new Set<string>();
  const topPriority = allScored
    .filter((it) => { if (seen.has(it.id)) return false; seen.add(it.id); return true; })
    .sort((a, b) => (b.aiScore ?? 0) - (a.aiScore ?? 0))
    .slice(0, 10);

  // Surface convs that need scoring — top 50 unscored items from the rule
  // buckets so the client can run score-batch on them.
  const unscored = [...hot, ...overdue, ...goingCold, ...stale]
    .filter((it) => it.aiScore === null)
    .slice(0, 50)
    .map((it) => it.id);

  return NextResponse.json(
    {
      topPriority,
      hot,
      overdue,
      goingCold,
      stale,
      counts: {
        topPriority: topPriority.length,
        hot: hot.length,
        overdue: overdue.length,
        goingCold: goingCold.length,
        stale: stale.length,
        total: hot.length + overdue.length + goingCold.length + stale.length,
      },
      unscored, // client can trigger score-batch with these ids
    },
    { headers: CORS },
  );
}

export async function OPTIONS() {
  return optionsResponse();
}
