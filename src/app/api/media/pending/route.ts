import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse, safeParseArray } from '@/lib/api-utils';
import type { MessageAttachment } from '@/types';

// GET /api/media/pending?limit=150
// Returns attachments whose bytes haven't been downloaded yet (remoteUrl
// present, localPath still null/undefined). The extension polls this after a
// sync, fetches each remoteUrl with the user's LinkedIn auth, and POSTs the
// bytes to /api/media/ingest.
//
// localPath semantics: undefined/null = not tried; '' = tried-and-failed
// (expired/403, do not retry); non-empty = downloaded. We only surface the
// "not tried" ones, newest messages first.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 150));

  // Scan recent messages that have any attachments. Newest first — fresh syncs
  // carry valid signed URLs; ancient ones are likely expired anyway.
  const rows = await prisma.message.findMany({
    where: { attachments: { not: null } },
    orderBy: { sentAt: 'desc' },
    select: { id: true, attachments: true },
    take: 2000,
  });

  const pending: Array<{
    messageId: string;
    index: number;
    kind: string;
    remoteUrl: string;
    mediaType?: string;
    name?: string;
  }> = [];

  for (const r of rows) {
    const items = safeParseArray<MessageAttachment>(r.attachments ?? '[]', []);
    items.forEach((a, index) => {
      if (a.remoteUrl && (a.localPath === undefined || a.localPath === null)) {
        pending.push({
          messageId: r.id,
          index,
          kind: a.kind,
          remoteUrl: a.remoteUrl,
          mediaType: a.mediaType,
          name: a.name,
        });
      }
    });
    if (pending.length >= limit) break;
  }

  return NextResponse.json({ pending: pending.slice(0, limit) }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
