import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// Returns IDs of conversations whose participant data is missing or contains
// only "LinkedIn User" stubs — these need a re-fetch to get real names.
export async function GET() {
  const rows = await prisma.conversation.findMany({
    select: { id: true, participants: true },
  });
  const weak: string[] = [];
  for (const r of rows) {
    let parsed: unknown;
    try { parsed = JSON.parse(r.participants); } catch { weak.push(r.id); continue; }
    if (!Array.isArray(parsed) || parsed.length === 0) { weak.push(r.id); continue; }
    const allBad = (parsed as Array<{ name?: string }>).every(
      (p) => !p?.name || p.name === 'LinkedIn User',
    );
    if (allBad) weak.push(r.id);
  }
  return NextResponse.json({ ids: weak, count: weak.length }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
