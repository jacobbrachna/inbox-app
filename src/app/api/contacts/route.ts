import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET /api/contacts?includeAnonymous=1
// Returns the contact list with the fields the browser table needs.
// By default, anonymous LinkedIn placeholders ("LinkedIn User" / "LinkedIn
// Member" with no URN and no slug — almost always deleted/blocked/restricted
// accounts) are filtered out. Pass ?includeAnonymous=1 to include them.
export async function GET(req: NextRequest) {
  const includeAnonymous = req.nextUrl.searchParams.get('includeAnonymous') === '1';

  const where = includeAnonymous
    ? {}
    : {
        NOT: {
          AND: [
            { name: { in: ['LinkedIn User', 'LinkedIn Member'] } },
            { linkedinUrn: null },
            { profileSlug: null },
          ],
        },
      };

  const rows = await prisma.contact.findMany({
    where,
    select: {
      id: true,
      name: true,
      profileUrl: true,
      avatarUrl: true,
      headline: true,
      company: true,
      role: true,
      location: true,
      source: true,
      conversationCount: true,
      outboundCount: true,
      inboundCount: true,
      lastOutboundAt: true,
      lastInboundAt: true,
      firstSeenAt: true,
      lastSeenAt: true,
    },
    orderBy: [{ lastSeenAt: 'desc' }],
  });
  return NextResponse.json({ contacts: rows }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
