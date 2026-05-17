import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import type { Label } from '@/types';

export async function GET() {
  const rows = await prisma.label.findMany();
  const labels: Label[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    description: r.description,
    aiManaged: r.aiManaged,
    exclusiveGroup: r.exclusiveGroup,
  }));
  return NextResponse.json({ labels }, { headers: CORS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    // Accept either a single label or { labels: [...] }
    const incoming: Label[] = Array.isArray(body?.labels)
      ? body.labels
      : body?.id
        ? [body]
        : [];

    for (const l of incoming) {
      if (!l?.id) continue;
      const description = l.description ?? null;
      // A label is AI-managed when it has a description (so the AI knows how
      // to apply it). Explicit aiManaged in the payload overrides this default.
      const aiManaged = typeof l.aiManaged === 'boolean'
        ? l.aiManaged
        : !!description;
      const exclusiveGroup = l.exclusiveGroup ?? null;

      await prisma.label.upsert({
        where: { id: l.id },
        update: {
          name: l.name,
          color: l.color,
          ...(description !== undefined ? { description } : {}),
          aiManaged,
          exclusiveGroup,
        },
        create: {
          id: l.id,
          name: l.name,
          color: l.color,
          description,
          aiManaged,
          exclusiveGroup,
        },
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
