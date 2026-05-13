import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { safeParseArray } from '@/lib/api-utils';

interface Participant {
  id: string;
  name?: string;
  headline?: string;
  profileUrl?: string;
}

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v).replace(/"/g, '""').replace(/\n/g, ' ');
  return `"${s}"`;
}

// GET /api/export?format=csv  → all conversations as CSV
// GET /api/export?format=md&conversationId=urn:li:...  → single thread as Markdown
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const format = searchParams.get('format') || 'csv';
  const conversationId = searchParams.get('conversationId');

  if (format === 'md' && conversationId) {
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const msgs = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { sentAt: 'asc' },
    });
    const participants = safeParseArray<Participant>(conv.participants);
    const other = participants[0];
    const lines: string[] = [];
    lines.push(`# Conversation with ${other?.name ?? 'LinkedIn User'}`);
    if (other?.headline) lines.push(`*${other.headline}*`);
    if (other?.profileUrl) lines.push(`<${other.profileUrl}>`);
    lines.push('');
    for (const m of msgs) {
      const ts = m.sentAt.toISOString().replace('T', ' ').slice(0, 16);
      lines.push(`**${m.senderName}** · ${ts}`);
      lines.push('');
      lines.push(m.body);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/markdown',
        'Content-Disposition': `attachment; filename="conversation-${conversationId.slice(-12)}.md"`,
      },
    });
  }

  // CSV export of all conversations
  const conversations = await prisma.conversation.findMany({
    orderBy: { lastMessageAt: 'desc' },
  });
  const header = [
    'name', 'headline', 'profileUrl', 'source', 'status',
    'isStarred', 'lastMessageAt', 'unreadCount', 'lastMessage', 'labels',
  ];
  const rows = [header.map(csvEscape).join(',')];
  for (const c of conversations) {
    const ps = safeParseArray<Participant>(c.participants);
    const other = ps[0];
    const labels = safeParseArray<string>(c.labels);
    rows.push([
      other?.name ?? '',
      other?.headline ?? '',
      other?.profileUrl ?? '',
      c.source,
      c.status,
      c.isStarred ? 'true' : 'false',
      c.lastMessageAt.toISOString(),
      c.unreadCount,
      c.lastMessage,
      labels.join(';'),
    ].map(csvEscape).join(','));
  }
  return new Response(rows.join('\n'), {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="inboxpro-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
