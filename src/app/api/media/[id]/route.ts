import { NextRequest } from 'next/server';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { readMedia, contentTypeForFile } from '@/lib/media-store';

// GET /api/media/<filename> — stream a downloaded attachment from the local
// media dir. The renderer loads this directly in <img>/<audio>/<video>/<a>.
// `<filename>` is the value stored in MessageAttachment.localPath, which is a
// plain basename; media-store rejects anything that looks like a path.
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const buf = readMedia(decodeURIComponent(id));
  if (!buf) {
    return new Response('Not found', { status: 404, headers: CORS });
  }
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': contentTypeForFile(id),
      'Content-Length': String(buf.length),
      // Local immutable bytes — safe to cache hard.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}

export async function OPTIONS() {
  return optionsResponse();
}
