import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import type { Message } from '@/types';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rows = await prisma.message.findMany({
    where: { conversationId: id },
    orderBy: { sentAt: 'asc' },
  });
  const messages: Message[] = rows.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    senderId: r.senderId,
    senderName: r.senderName,
    body: r.body,
    sentAt: r.sentAt.toISOString(),
    isFromMe: r.isFromMe,
  }));
  return NextResponse.json({ messages }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
