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
    }
    if (patch.notes !== undefined) data.notes = patch.notes;
    if (patch.labels !== undefined) data.labels = JSON.stringify(patch.labels);

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
