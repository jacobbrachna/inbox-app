import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import type { Snippet } from '@/types';

export async function GET() {
  const rows = await prisma.snippet.findMany();
  const snippets: Snippet[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    shortcut: r.shortcut,
    body: r.body,
  }));
  return NextResponse.json({ snippets }, { headers: CORS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const incoming: Snippet[] = Array.isArray(body?.snippets)
      ? body.snippets
      : body?.id
        ? [body]
        : [];

    for (const s of incoming) {
      if (!s?.id) continue;
      await prisma.snippet.upsert({
        where: { id: s.id },
        update: { name: s.name, shortcut: s.shortcut, body: s.body },
        create: { id: s.id, name: s.name, shortcut: s.shortcut, body: s.body },
      });
    }

    return NextResponse.json({ ok: true, count: incoming.length }, { headers: CORS });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
