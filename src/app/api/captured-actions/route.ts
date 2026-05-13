import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { CORS, optionsResponse } from '@/lib/api-utils';

const LOG_PATH = path.join(process.cwd(), 'captured-actions.log');

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const line = JSON.stringify({ ...body, t: new Date().toISOString() }) + '\n';
    await fs.appendFile(LOG_PATH, line, 'utf8');
    return NextResponse.json({ ok: true }, { headers: CORS });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown';
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS });
  }
}

export async function GET() {
  try {
    const txt = await fs.readFile(LOG_PATH, 'utf8').catch(() => '');
    const lines = txt.trim().split('\n').filter(Boolean);
    const entries = lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    return NextResponse.json({ count: entries.length, entries }, { headers: CORS });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown';
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS });
  }
}

export async function DELETE() {
  await fs.unlink(LOG_PATH).catch(() => {});
  return NextResponse.json({ ok: true }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
