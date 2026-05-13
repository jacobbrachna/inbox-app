import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET /api/raw?conv=<conv-urn>            → raw conv data + raw messages
// GET /api/raw?msg=<msg-id>                → raw single message
// GET /api/raw?search=<text>               → list message ids whose raw data
//                                            contains the search text
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const convId = searchParams.get('conv');
  const msgId = searchParams.get('msg');
  const search = searchParams.get('search');

  if (msgId) {
    const m = await prisma.message.findUnique({ where: { id: msgId } });
    return NextResponse.json(
      { id: m?.id, raw: m?.rawData ? JSON.parse(m.rawData) : null },
      { headers: CORS },
    );
  }

  if (convId) {
    const c = await prisma.conversation.findUnique({ where: { id: convId } });
    const msgs = await prisma.message.findMany({
      where: { conversationId: convId },
      orderBy: { sentAt: 'asc' },
    });
    return NextResponse.json({
      conversation: {
        id: c?.id,
        raw: c?.rawData ? JSON.parse(c.rawData) : null,
      },
      messages: msgs.map((m) => ({
        id: m.id,
        senderId: m.senderId,
        senderName: m.senderName,
        isFromMe: m.isFromMe,
        body: m.body.slice(0, 80),
        raw: m.rawData ? JSON.parse(m.rawData) : null,
      })),
    }, { headers: CORS });
  }

  if (search) {
    const rows = await prisma.message.findMany({
      where: { rawData: { contains: search } },
      select: { id: true, senderName: true, body: true },
      take: 20,
    });
    return NextResponse.json({ count: rows.length, rows }, { headers: CORS });
  }

  return NextResponse.json(
    { error: 'pass ?conv=, ?msg=, or ?search=' },
    { status: 400, headers: CORS },
  );
}

export async function OPTIONS() {
  return optionsResponse();
}
