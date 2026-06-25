import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse, safeParseArray } from '@/lib/api-utils';
import { saveMedia, mediaFilename } from '@/lib/media-store';
import type { MessageAttachment } from '@/types';

// POST /api/media/ingest?messageId=<id>&i=<index>&field=main|thumb&failed=1
// Body: raw bytes of the attachment (application/octet-stream).
//
// The extension fetches LinkedIn's signed media URL (with the user's auth) and
// POSTs the bytes here. We persist them to the local media dir and record the
// filename on the message's attachment so the UI can load /api/media/<file>.
//
// failed=1 (no body): the extension couldn't fetch (expired/403). We mark the
// attachment localPath='' so /api/media/pending stops returning it.
export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const messageId = url.searchParams.get('messageId') ?? '';
    const index = Number(url.searchParams.get('i'));
    const field = url.searchParams.get('field') === 'thumb' ? 'thumb' : 'main';
    const failed = url.searchParams.get('failed') === '1';

    if (!messageId || !Number.isInteger(index) || index < 0) {
      return NextResponse.json({ error: 'messageId and integer i required' }, { status: 400, headers: CORS });
    }

    const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { attachments: true } });
    if (!msg?.attachments) {
      return NextResponse.json({ error: 'message has no attachments' }, { status: 404, headers: CORS });
    }
    const items = safeParseArray<MessageAttachment>(msg.attachments, []);
    const att = items[index];
    if (!att) {
      return NextResponse.json({ error: 'attachment index out of range' }, { status: 404, headers: CORS });
    }

    if (failed) {
      // Mark as tried-and-unavailable so we don't re-poll it forever.
      if (field === 'thumb') att.thumbLocalPath = '';
      else att.localPath = '';
    } else {
      const buf = Buffer.from(await req.arrayBuffer());
      if (buf.length === 0) {
        return NextResponse.json({ error: 'empty body' }, { status: 400, headers: CORS });
      }
      const filename = mediaFilename(
        messageId,
        field === 'thumb' ? index + 1000 : index, // keep thumb + main filenames distinct
        att.mediaType,
        att.name,
      );
      if (!saveMedia(filename, buf)) {
        return NextResponse.json({ error: 'failed to write media' }, { status: 500, headers: CORS });
      }
      if (field === 'thumb') att.thumbLocalPath = filename;
      else att.localPath = filename;
    }

    items[index] = att;
    await prisma.message.update({
      where: { id: messageId },
      data: { attachments: JSON.stringify(items) },
    });

    return NextResponse.json(
      { ok: true, localPath: field === 'thumb' ? att.thumbLocalPath : att.localPath },
      { headers: CORS },
    );
  } catch (e) {
    const m = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: m }, { status: 500, headers: CORS });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
