import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { CORS, optionsResponse } from '@/lib/api-utils';

const LOG_PATH = path.join(process.cwd(), 'sync-events.log');
const MAX_LINES = 1000; // keep the log bounded

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const line = JSON.stringify({
      t: new Date().toISOString(),
      src: body.src ?? 'unknown',
      ev: body.ev ?? 'unknown',
      ...body,
    }) + '\n';
    await fs.appendFile(LOG_PATH, line, 'utf8');

    // Trim file if it grows too large
    try {
      const stat = await fs.stat(LOG_PATH);
      if (stat.size > 500_000) {
        const txt = await fs.readFile(LOG_PATH, 'utf8');
        const lines = txt.trim().split('\n').slice(-MAX_LINES);
        await fs.writeFile(LOG_PATH, lines.join('\n') + '\n', 'utf8');
      }
    } catch {}

    return NextResponse.json({ ok: true }, { headers: CORS });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'unknown' }, { status: 500, headers: CORS });
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const tail = parseInt(searchParams.get('tail') ?? '100', 10);
  try {
    const txt = await fs.readFile(LOG_PATH, 'utf8').catch(() => '');
    const lines = txt.trim().split('\n').filter(Boolean).slice(-tail);
    return NextResponse.json({ count: lines.length, lines }, { headers: CORS });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'unknown' }, { status: 500, headers: CORS });
  }
}

export async function DELETE() {
  await fs.unlink(LOG_PATH).catch(() => {});
  return NextResponse.json({ ok: true }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
