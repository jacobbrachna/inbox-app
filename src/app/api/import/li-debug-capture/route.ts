import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { CORS, optionsResponse } from '@/lib/api-utils';

// POST { label, body } — write a raw LinkedIn API response body to disk so
// we can inspect the shape locally. Used to design pagination logic against
// real data instead of guessing.

const DIR = path.join(process.cwd(), 'li-samples');

function fileSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}

export async function POST(req: NextRequest) {
  try {
    const { label, body } = await req.json();
    if (typeof body !== 'string') {
      return NextResponse.json({ error: 'body required' }, { status: 400, headers: CORS });
    }
    await fs.mkdir(DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${fileSafe(label || 'page')}.json`;
    const fp = path.join(DIR, name);
    await fs.writeFile(fp, body, 'utf8');
    return NextResponse.json({ ok: true, file: name, bytes: body.length }, { headers: CORS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'unknown' },
      { status: 500, headers: CORS },
    );
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
