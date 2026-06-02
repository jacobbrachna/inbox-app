import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET /api/contacts/by-slug/[slug]/context
//
// Rich context for the Relay side panel's "On this profile" card: the contact
// plus any conversation(s) with them — recent messages, which channel they're
// on (LinkedIn vs Sales Navigator), AI summary, ICP fit, follow-up, labels.
// Read-only; powers the panel's at-a-glance "who is this to me" view.

const SOURCE_LABEL: Record<string, string> = {
  linkedin: 'LinkedIn',
  sales_nav: 'Sales Navigator',
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!slug) return NextResponse.json({ exists: false }, { headers: CORS });

  const contact = await prisma.contact.findUnique({
    where: { profileSlug: slug },
    select: {
      name: true, headline: true, company: true, role: true,
      profileUrl: true, avatarUrl: true,
      conversations: {
        select: {
          conversation: {
            select: {
              id: true, source: true, lastMessageAt: true, aiSummary: true,
              aiIcpFit: true, manualIcp: true, followUpAt: true, followUpReason: true,
              labels: true,
              messages: {
                orderBy: { sentAt: 'desc' },
                take: 6,
                select: { body: true, isFromMe: true, sentAt: true, senderName: true },
              },
            },
          },
        },
      },
    },
  });

  if (!contact) return NextResponse.json({ exists: false }, { headers: CORS });

  // Resolve label IDs → { name, color } so the panel can render chips.
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
        // Reverse to chronological (oldest→newest) for display.
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
