import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET → { document } including rawText (the list endpoint omits it).
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404, headers: CORS });
  return NextResponse.json({ document: doc }, { headers: CORS });
}

// PATCH → update title/kind/includeByDefault (no re-summarize here; keep it cheap).
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json();
  const data: Record<string, unknown> = {};
  if (typeof body?.title === 'string') data.title = body.title.trim();
  if (typeof body?.kind === 'string') data.kind = body.kind.trim();
  if (typeof body?.includeByDefault === 'boolean') data.includeByDefault = body.includeByDefault;
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400, headers: CORS });
  }
  const doc = await prisma.document.update({ where: { id }, data });
  return NextResponse.json({ document: doc }, { headers: CORS });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await prisma.document.delete({ where: { id } });
  return NextResponse.json({ ok: true }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
