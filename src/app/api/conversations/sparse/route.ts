import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// Returns conversation IDs that have ≤1 message stored — i.e. that got their
// message history wiped by the old replace-strategy sync. The extension uses
// this to know which conversations need a full re-fetch from LinkedIn.
export async function GET() {
  const rows = await prisma.$queryRaw<{ conversationId: string; cnt: number }[]>`
    SELECT c.id as conversationId, COUNT(m.id) as cnt
    FROM Conversation c
    LEFT JOIN Message m ON m.conversationId = c.id
    GROUP BY c.id
    HAVING cnt <= 1
    LIMIT 1000
  `;
  return NextResponse.json({ ids: rows.map((r) => r.conversationId) }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
