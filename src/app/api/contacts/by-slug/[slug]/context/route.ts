import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET /api/contacts/by-slug/[slug]/context?name=<display name>
//
// Rich context for the Relay side panel's "On this profile" card: the contact
// plus any conversation(s) with them — recent messages, which channel they're
// on (LinkedIn vs Sales Navigator), AI summary, ICP fit, follow-up, labels.
//
// Lookup is slug-first. But most contacts come from message sync, which gives a
// URN + name but NOT the public profile slug — so a slug lookup alone misses
// people you've clearly messaged. When `name` is supplied (the panel reads it
// off the page) we fall back to matching the contact by normalized name, so the
// panel shows context immediately whether or not the profile's been imported.

const SOURCE_LABEL: Record<string, string> = {
  linkedin: 'LinkedIn',
  sales_nav: 'Sales Navigator',
};

const CONTACT_SELECT = {
  name: true,
  headline: true,
  company: true,
  role: true,
  profileUrl: true,
  avatarUrl: true,
  conversations: {
    select: {
      conversation: {
        select: {
          id: true, source: true, lastMessageAt: true, aiSummary: true,
          aiIcpFit: true, manualIcp: true, followUpAt: true, followUpReason: true,
          labels: true,
          messages: {
            orderBy: { sentAt: 'desc' as const },
            take: 6,
            select: { body: true, isFromMe: true, sentAt: true, senderName: true },
          },
        },
      },
    },
  },
} as const;

type ContactWithConvs = NonNullable<Awaited<ReturnType<typeof findBySlug>>>;
function findBySlug(slug: string) {
  return prisma.contact.findUnique({ where: { profileSlug: slug }, select: CONTACT_SELECT });
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!slug) return NextResponse.json({ exists: false }, { headers: CORS });
  // Read query robustly: NextRequest has .nextUrl under `next start`, but the
  // Electron handler passes a plain Request — fall back to parsing req.url.
  const searchParams = req.nextUrl?.searchParams ?? new URL(req.url).searchParams;
  const name = searchParams.get('name')?.trim() || '';

  let contact: ContactWithConvs | null = await findBySlug(slug);
  let matchedBy: 'slug' | 'name' = 'slug';

  // Fallback: match by name (for message-synced contacts that have no slug yet).
  if (!contact && name) {
    const candidates = await prisma.contact.findMany({
      where: { name: { contains: name } }, // SQLite LIKE = case-insensitive (ASCII)
      select: CONTACT_SELECT,
      take: 12,
    });
    const exact = candidates.filter((c) => norm(c.name) === norm(name));
    if (exact.length === 1) {
      contact = exact[0];
    } else if (exact.length > 1) {
      // Same name, multiple people — don't guess and risk showing the wrong
      // person's threads. Only match if exactly one of them has a conversation.
      const withConvs = exact.filter((c) => c.conversations.length > 0);
      contact = withConvs.length === 1 ? withConvs[0] : null;
    }
    matchedBy = 'name';
  }

  if (!contact) return NextResponse.json({ exists: false }, { headers: CORS });

  const allLabels = await prisma.label.findMany({ select: { id: true, name: true, color: true } });
  const labelMap = new Map(allLabels.map((l) => [l.id, l]));

  const conversations = contact.conversations
    .map((cc) => {
      const c = cc.conversation;
      let labelIds: string[] = [];
      try { labelIds = JSON.parse(c.labels || '[]'); } catch {}
      const labels = labelIds.map((id) => labelMap.get(id)).filter(Boolean);
      return {
        id: c.id,
        source: c.source,
        sourceLabel: SOURCE_LABEL[c.source] ?? c.source,
        lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
        aiSummary: c.aiSummary ?? null,
        aiIcpFit: c.aiIcpFit ?? null,
        manualIcp: c.manualIcp ?? false,
        followUpAt: c.followUpAt ? c.followUpAt.toISOString() : null,
        followUpReason: c.followUpReason ?? null,
        labels,
        messages: c.messages.slice().reverse().map((m) => ({
          body: m.body,
          isFromMe: m.isFromMe,
          sentAt: m.sentAt.toISOString(),
          senderName: m.senderName,
        })),
      };
    })
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));

  return NextResponse.json({
    exists: true,
    matchedBy,
    contact: {
      name: contact.name,
      headline: contact.headline,
      company: contact.company,
      role: contact.role,
      profileUrl: contact.profileUrl,
      avatarUrl: contact.avatarUrl,
    },
    conversations,
  }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
