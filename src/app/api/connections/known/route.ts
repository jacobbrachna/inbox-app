import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET /api/connections/known → { slugs: string[] }
// The watermark for the extension's incremental connections sync: every
// profileSlug we already have. The in-tab sweep stops once it hits a run of
// these (the Connections page is newest-first, so below that run is already
// synced). Lowercased to match the extension's comparison.
export async function GET() {
  const rows = await prisma.contact.findMany({
    where: { profileSlug: { not: null } },
    select: { profileSlug: true },
    take: 20000,
  });
  const slugs = rows
    .map((r) => r.profileSlug?.toLowerCase())
    .filter((s): s is string => !!s);
  return NextResponse.json({ slugs }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
