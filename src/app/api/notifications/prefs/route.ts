import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { parseNotificationPrefs } from '@/lib/notification-prefs';

// GET  /api/notifications/prefs → the fully-populated prefs object.
// POST /api/notifications/prefs { prefs } → persist (stored as JSON on AppState).
export async function GET() {
  const state = await prisma.appState.findUnique({ where: { id: 1 } });
  return NextResponse.json({ prefs: parseNotificationPrefs(state?.notificationPrefs) }, { headers: CORS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const prefs = body?.prefs;
    if (!prefs || typeof prefs !== 'object') {
      return NextResponse.json({ error: 'prefs required' }, { status: 400, headers: CORS });
    }
    // Normalize through the parser so we only ever store a well-formed blob.
    const clean = parseNotificationPrefs(JSON.stringify(prefs));
    await prisma.appState.upsert({
      where: { id: 1 },
      update: { notificationPrefs: JSON.stringify(clean) },
      create: { id: 1, notificationPrefs: JSON.stringify(clean) },
    });
    return NextResponse.json({ ok: true, prefs: clean }, { headers: CORS });
  } catch (e) {
    const m = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: m }, { status: 500, headers: CORS });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
