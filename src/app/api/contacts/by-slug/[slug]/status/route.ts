import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET → { exists, messageable }
// Used by the extension's content scripts to decide whether to silently
// refresh an existing contact (messageable=true) or wait for an explicit
// "Import to InboxPro" button click (messageable=false). Definition:
// messageable = Contact has at least one linked Conversation.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!slug) return NextResponse.json({ exists: false, messageable: false }, { headers: CORS });

  const contact = await prisma.contact.findUnique({
    where: { profileSlug: slug },
    select: { id: true, _count: { select: { conversations: true } } },
  });

  if (!contact) {
    return NextResponse.json({ exists: false, messageable: false }, { headers: CORS });
  }
  return NextResponse.json({
    exists: true,
    messageable: contact._count.conversations > 0,
  }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
