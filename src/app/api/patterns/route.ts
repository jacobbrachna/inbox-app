import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET → meta about your own most-recent winning-patterns doc:
//   • lastGeneratedAt  — createdAt of the latest one (yours, not imported)
//   • messagesSince    — outbound messages sent since that timestamp
// Used by the Documents panel to show the "+N new messages" delta and
// nudge regeneration.
// Same LinkedIn date parser used by patterns/generate — duplicated here
// because cross-route imports trip prisma client init in some Next builds.
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
function parseLinkedInDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const s2 = s.trim().toLowerCase();
  const my = s2.match(/^([a-z]{3})[a-z]*\s+(\d{4})$/);
  if (my && MONTHS[my[1]] !== undefined) return new Date(parseInt(my[2], 10), MONTHS[my[1]], 1);
  const y = s2.match(/^(\d{4})$/);
  if (y) return new Date(parseInt(y[1], 10), 0, 1);
  return null;
}

export async function GET() {
  const state = await prisma.appState.findUnique({ where: { id: 1 } });

  // Derive the "current role window" so the UI can preview how big the
  // next analysis run will be.
  let history: Array<{ role?: string | null; company?: string | null; from?: string | null; to?: string | null }> = [];
  try { history = state?.myEmploymentHistory ? JSON.parse(state.myEmploymentHistory) : []; } catch {}
  const current = history.filter((e) => e.to === null || (typeof e.to === 'string' && /present/i.test(e.to)));
  let currentEntry = current[0] ?? null;
  let currentStart: Date | null = currentEntry ? parseLinkedInDate(currentEntry.from) : null;
  for (const e of current.slice(1)) {
    const d = parseLinkedInDate(e.from);
    if (d && (!currentStart || d > currentStart)) { currentEntry = e; currentStart = d; }
  }

  // We only care about docs the user generated themselves, not teammate
  // imports. Heuristic: self-generated docs have sourceFilename = null.
  const latest = await prisma.document.findFirst({
    where: { kind: 'winning-patterns', sourceFilename: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true, title: true },
  });

  // Count outbound messages eligible for the next run (filtered by current
  // role window if available, otherwise all-time).
  const inWindow = await prisma.message.count({
    where: {
      isFromMe: true,
      ...(currentStart ? { sentAt: { gte: currentStart } } : {}),
    },
  });

  if (!latest) {
    return NextResponse.json({
      lastGeneratedAt: null,
      lastTitle: null,
      messagesSince: inWindow,
      windowStart: currentStart?.toISOString() ?? null,
      windowEntry: currentEntry ? { role: currentEntry.role, company: currentEntry.company, from: currentEntry.from } : null,
      eligibleInWindow: inWindow,
    }, { headers: CORS });
  }

  const messagesSince = await prisma.message.count({
    where: {
      isFromMe: true,
      sentAt: { gt: latest.createdAt },
      ...(currentStart ? { sentAt: { gt: currentStart > latest.createdAt ? currentStart : latest.createdAt } } : {}),
    },
  });

  return NextResponse.json({
    lastGeneratedAt: latest.createdAt,
    lastTitle: latest.title,
    messagesSince,
    windowStart: currentStart?.toISOString() ?? null,
    windowEntry: currentEntry ? { role: currentEntry.role, company: currentEntry.company, from: currentEntry.from } : null,
    eligibleInWindow: inWindow,
  }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
