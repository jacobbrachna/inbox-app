import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { parseAttachmentsFromRaw, deriveGroupForRaw } from '@/lib/transform';

// POST /api/maintenance/backfill-attachments
// One-time (idempotent) backfill: re-derive message attachments + conversation
// group metadata from already-stored rawData — no LinkedIn re-sync needed. The
// extension's media drain then downloads bytes for any attachment whose signed
// URL is still valid. Safe to run repeatedly.
export async function POST() {
  let msgScanned = 0, msgUpdated = 0, attachmentsFound = 0;
  let convScanned = 0, groupsFound = 0;

  // ── Messages: parse renderContent → attachments ──────────────────────────
  // Only touch rows that don't already have attachments parsed. Page through
  // in id-stable batches to bound memory on large inboxes.
  const PAGE = 500;
  let cursor: string | undefined;
  const convsWithMedia = new Set<string>();
  for (;;) {
    const rows = await prisma.message.findMany({
      where: { attachments: null, rawData: { not: null } },
      select: { id: true, conversationId: true, rawData: true },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const r of rows) {
      msgScanned++;
      let raw: unknown;
      try { raw = JSON.parse(r.rawData as string); } catch { continue; }
      const atts = parseAttachmentsFromRaw(raw);
      if (atts.length > 0) {
        await prisma.message.update({
          where: { id: r.id },
          data: { attachments: JSON.stringify(atts) },
        }).catch(() => {});
        msgUpdated++;
        attachmentsFound += atts.length;
        convsWithMedia.add(r.conversationId);
      }
    }
    if (rows.length < PAGE) break;
  }

  // Denormalized attachments flag on every conversation that has media.
  for (const convId of convsWithMedia) {
    await prisma.conversation.update({
      where: { id: convId },
      data: { hasAttachments: true },
    }).catch(() => {});
  }

  // ── Conversations: re-derive group metadata ──────────────────────────────
  const state = await prisma.appState.findUnique({ where: { id: 1 } });
  const myUrn = state?.myProfileUrn ?? '';
  const convs = await prisma.conversation.findMany({
    where: { rawData: { not: null } },
    select: { id: true, rawData: true },
  });
  for (const c of convs) {
    convScanned++;
    let raw: unknown;
    try { raw = JSON.parse(c.rawData as string); } catch { continue; }
    const g = deriveGroupForRaw(raw, myUrn);
    if (g.isGroup || g.memberCount !== null) {
      await prisma.conversation.update({
        where: { id: c.id },
        data: { isGroup: g.isGroup, memberCount: g.memberCount, groupName: g.groupName },
      }).catch(() => {});
      if (g.isGroup) groupsFound++;
    }
  }

  return NextResponse.json(
    { ok: true, msgScanned, msgUpdated, attachmentsFound, convScanned, groupsFound },
    { headers: CORS },
  );
}

export async function OPTIONS() {
  return optionsResponse();
}
