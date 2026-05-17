import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET /api/notifications?unread=true&limit=50
// Default: returns latest 50 not-dismissed notifications, newest first.
// Pass unread=true to filter to read=false only.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const unreadOnly = searchParams.get('unread') === 'true';
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10)));

  const rows = await prisma.notification.findMany({
    where: {
      dismissed: false,
      ...(unreadOnly ? { read: false } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  const unreadCount = await prisma.notification.count({
    where: { dismissed: false, read: false },
  });
  return NextResponse.json({
    notifications: rows.map((n) => ({
      ...n,
      meta: n.meta ? safeJson(n.meta) : null,
    })),
    unreadCount,
  }, { headers: CORS });
}

// POST /api/notifications/mark-all-read — convenience batch update.
// Lives at the collection root for simplicity (no separate route file).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body?.action === 'mark-all-read') {
    const result = await prisma.notification.updateMany({
      where: { read: false, dismissed: false },
      data: { read: true },
    });
    return NextResponse.json({ ok: true, updated: result.count }, { headers: CORS });
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400, headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
