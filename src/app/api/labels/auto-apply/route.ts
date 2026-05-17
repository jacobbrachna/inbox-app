import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { AUTO_LABELS, detectAutoLabels, ensureAutoLabelsSeeded, applyAutoLabelsToConversation } from '@/lib/auto-label';
import { hasApiKey } from '@/lib/ai';

// POST /api/labels/auto-apply — scan every conversation's most recent inbound
// messages, run regex auto-labelers, and persist matching labels. Idempotent.
//
// Lightweight: ~few hundred ms for 1500 conversations. Pure regex, no AI.
// SKIPPED when an Anthropic API key is configured — AI classification handles
// labeling exclusively in that mode.
export async function POST() {
  if (await hasApiKey()) {
    return NextResponse.json(
      { ok: true, skipped: true, reason: 'API key configured — AI classification handles labels' },
      { headers: CORS },
    );
  }
  await ensureAutoLabelsSeeded();

  // Page through conversations to stay under SQLite's parameter limit (the
  // relational include on messages can otherwise blow past 999 bind params).
  const convIds = await prisma.conversation.findMany({
    where: { status: { not: 'archived' } },
    select: { id: true },
    orderBy: { lastMessageAt: 'desc' },
  });

  const perLabel: Record<string, number> = {};
  let touched = 0;
  let scanned = 0;

  const PAGE = 100;
  for (let i = 0; i < convIds.length; i += PAGE) {
    const slice = convIds.slice(i, i + PAGE).map((c) => c.id);
    const page = await prisma.conversation.findMany({
      where: { id: { in: slice } },
      select: {
        id: true,
        messages: {
          where: { isFromMe: false },
          orderBy: { sentAt: 'desc' },
          take: 3,
          select: { body: true },
        },
      },
    });
    for (const c of page) {
      scanned++;
      const combined = c.messages.map((m) => m.body).join('\n').slice(0, 4000);
      if (!combined) continue;
      const labels = detectAutoLabels(combined);
      if (labels.length === 0) continue;
      const added = await applyAutoLabelsToConversation(c.id, labels);
      if (added.length > 0) {
        touched++;
        for (const id of added) perLabel[id] = (perLabel[id] ?? 0) + 1;
      }
    }
  }

  return NextResponse.json(
    {
      ok: true,
      scanned,
      touched,
      perLabel,
      autoLabels: AUTO_LABELS.map((l) => ({ id: l.id, name: l.name })),
    },
    { headers: CORS },
  );
}

export async function OPTIONS() {
  return optionsResponse();
}
