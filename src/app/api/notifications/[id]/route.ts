import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// PATCH /api/notifications/[id]  body: { read?, dismissed? }
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {};
  if (typeof body?.read === 'boolean') data.read = body.read;
  if (typeof body?.dismissed === 'boolean') data.dismissed = body.dismissed;
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400, headers: CORS });
  }
  const updated = await prisma.notification.update({ where: { id }, data });
  return NextResponse.json({ notification: updated }, { headers: CORS });
}

// DELETE /api/notifications/[id] — hard delete (not just dismiss).
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await prisma.notification.delete({ where: { id } });
  return NextResponse.json({ ok: true }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
