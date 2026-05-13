import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET → { ids: string[] }
// Returns conversation IDs that haven't been AI-classified yet, newest first.
export async function GET() {
  const rows = await prisma.conversation.findMany({
    where: {
      OR: [{ aiCategory: null }, { aiSummary: null }],
      status: { not: 'archived' },
    },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  });
  return NextResponse.json({ ids: rows.map((r) => r.id) }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
