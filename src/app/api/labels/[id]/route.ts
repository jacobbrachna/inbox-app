import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const data: Record<string, unknown> = {};
    if (typeof body.name === 'string') data.name = body.name;
    if (typeof body.color === 'string') data.color = body.color;
    if (body.description === null || typeof body.description === 'string') {
      data.description = body.description;
      data.aiManaged = typeof body.description === 'string' && body.description.length > 0;
    }
    if (typeof body.aiManaged === 'boolean') data.aiManaged = body.aiManaged;
    if (body.exclusiveGroup === null || typeof body.exclusiveGroup === 'string') {
      data.exclusiveGroup = body.exclusiveGroup || null;
    }
    const updated = await prisma.label.update({ where: { id }, data });
    return NextResponse.json({ ok: true, label: updated }, { headers: CORS });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS });
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    // Strip this label id from every conversation that has it before
    // deleting the Label row. Avoids dangling references in conv.labels JSON.
    const tagged = await prisma.conversation.findMany({
      where: { labels: { contains: `"${id}"` } },
      select: { id: true, labels: true },
    });
    let stripped = 0;
    for (const c of tagged) {
      let arr: string[];
      try { arr = JSON.parse(c.labels); } catch { continue; }
      const next = arr.filter((x) => x !== id);
      if (next.length !== arr.length) {
        await prisma.conversation.update({
          where: { id: c.id },
          data: { labels: JSON.stringify(next) },
        });
        stripped++;
      }
    }
    await prisma.label.delete({ where: { id } }).catch(() => {});
    return NextResponse.json({ ok: true, strippedFrom: stripped }, { headers: CORS });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
