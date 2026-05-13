import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { CORS, optionsResponse } from '@/lib/api-utils';

// POST { url, body, label? }
// Writes raw SN API response bodies to /sn-samples for inspection. Used to
// reverse-engineer SN's response shapes so we can write real parsers.

const DIR = path.join(process.cwd(), 'sn-samples');

function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function fileSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}

export async function POST(req: NextRequest) {
  try {
    const { url, body, label } = await req.json();
    if (typeof url !== 'string' || typeof body !== 'string') {
      return NextResponse.json({ error: 'url + body required' }, { status: 400, headers: CORS });
    }
    await fs.mkdir(DIR, { recursive: true });

    // Filename: <label>-<urlHash>-<bodyHash>.json so each unique response only
    // gets written once across multiple runs.
    const urlKey = fileSafe(label || url.split('?')[0].split('/').pop() || 'unknown');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${urlKey}-${shortHash(body)}.json`;
    const fp = path.join(DIR, name);

    const payload = {
      capturedAt: new Date().toISOString(),
      url,
      label: label || null,
      bytes: body.length,
      body,
    };
    await fs.writeFile(fp, JSON.stringify(payload, null, 2), 'utf8');
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
