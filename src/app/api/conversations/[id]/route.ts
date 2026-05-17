import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import type { Conversation } from '@/types';

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const patch: Partial<Conversation> = await req.json();

    // Server-side guard: draft rows (id starts with "draft:") cannot have
    // their status flipped to anything other than 'draft'. Send + discard
    // each have dedicated flows (send → delete the row, discard → delete
    // the row). Anything else promoting status to read/archived/etc. would
    // be a bug — and a particularly nasty one, because the row then leaks
    // into All Messages / Archived under a meaningless "draft:" ID.
    const isDraftId = typeof id === 'string' && id.startsWith('draft:');
    if (isDraftId && patch.status !== undefined && patch.status !== 'draft') {
      return NextResponse.json(
        { ok: true, id, skipped: 'status-change-blocked-on-draft' },
        { headers: CORS },
      );
    }

    // Build the prisma update payload, JSON.stringify'ing arrays.
    const data: Record<string, unknown> = {};
    if (patch.source !== undefined) data.source = patch.source;
    if (patch.participants !== undefined) data.participants = JSON.stringify(patch.participants);
    if (patch.lastMessage !== undefined) data.lastMessage = patch.lastMessage;
    if (patch.lastMessageAt !== undefined) data.lastMessageAt = new Date(patch.lastMessageAt);
    if (patch.unreadCount !== undefined) data.unreadCount = patch.unreadCount;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.isStarred !== undefined) data.isStarred = patch.isStarred;
    if (patch.snoozedUntil !== undefined) {
      data.snoozedUntil = patch.snoozedUntil ? new Date(patch.snoozedUntil) : null;
    }
    if (patch.followUpAt !== undefined) {
      data.followUpAt = patch.followUpAt ? new Date(patch.followUpAt) : null;
      // Any user-driven change to followUpAt marks it as manual. Clearing
      // (null) also clears the reason + confidence — they only apply to AI.
      if (patch.followUpAt) {
        data.followUpSource = patch.followUpSource ?? 'manual';
        if (patch.followUpSource === 'manual' || patch.followUpSource === undefined) {
          data.followUpReason = null;
          data.followUpConfidence = null;
        }
      } else {
        data.followUpSource = null;
        data.followUpReason = null;
        data.followUpConfidence = null;
      }
    }
    if (patch.notes !== undefined) data.notes = patch.notes;
    if (patch.labels !== undefined) {
      data.labels = JSON.stringify(patch.labels);
      // Manual label change clears the review flag — the user just decided.
      data.needsReview = false;
    }
    if (patch.needsReview !== undefined) data.needsReview = patch.needsReview;

    const updated = await prisma.conversation.update({
      where: { id },
      data,
    });

    return NextResponse.json({ ok: true, id: updated.id }, { headers: CORS });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS });
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    // Messages cascade-delete via the relation
    await prisma.conversation.delete({ where: { id } });
    return NextResponse.json({ ok: true, id }, { headers: CORS });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
