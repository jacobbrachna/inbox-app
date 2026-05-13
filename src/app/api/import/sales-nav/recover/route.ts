import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// POST /api/import/sales-nav/recover
//
// One-shot recovery for SN convs that were imported with placeholder "now"
// timestamps (because the extension's parseSnTime couldn't read SN's DOM time
// labels). Two fixes:
//   1. Any sn: conv whose lastMessageAt is within the last 6 hours AND has
//      ZERO messages is clearly a placeholder — reset to epoch so it sorts
//      to the bottom of the inbox until a real message arrives.
//   2. For any sn: conv whose participant lacks profileUrl, name-match
//      against existing LinkedIn-source convs that DO have a profileUrl,
//      and copy it onto the participant.

function normalizeName(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/,.*$/, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Participant = { id?: string; name?: string; profileUrl?: string };

export async function POST() {
  try {
    // Step 1: reset placeholder timestamps on message-less SN convs
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const placeholderCandidates = await prisma.conversation.findMany({
      where: {
        id: { startsWith: 'sn:' },
        lastMessageAt: { gt: sixHoursAgo },
      },
      select: { id: true, _count: { select: { messages: true } } },
    });
    const toReset = placeholderCandidates.filter((c) => c._count.messages === 0).map((c) => c.id);
    if (toReset.length > 0) {
      await prisma.conversation.updateMany({
        where: { id: { in: toReset } },
        data: { lastMessageAt: new Date(0) },
      });
    }

    // Step 2: build a name → profileUrl map from LinkedIn convs
    const liConvs = await prisma.conversation.findMany({
      where: {
        source: 'linkedin',
        participants: { contains: 'linkedin.com/in/' },
      },
      select: { participants: true },
    });
    const nameToUrl = new Map<string, string>();
    for (const c of liConvs) {
      let parts: Participant[] = [];
      try { parts = JSON.parse(c.participants); } catch { continue; }
      for (const p of parts) {
        if (!p?.name || !p?.profileUrl) continue;
        if (!p.profileUrl.includes('linkedin.com/in/')) continue;
        const key = normalizeName(p.name);
        if (!key) continue;
        if (!nameToUrl.has(key)) nameToUrl.set(key, p.profileUrl);
      }
    }

    // Step 3: walk SN convs and patch participants with the matched URL
    const snConvs = await prisma.conversation.findMany({
      where: { id: { startsWith: 'sn:' } },
      select: { id: true, participants: true },
    });
    let urlPatched = 0;
    for (const c of snConvs) {
      let parts: Participant[] = [];
      try { parts = JSON.parse(c.participants); } catch { continue; }
      let changed = false;
      const next = parts.map((p) => {
        if (p?.profileUrl) return p;
        if (!p?.name) return p;
        const hit = nameToUrl.get(normalizeName(p.name));
        if (!hit) return p;
        changed = true;
        return { ...p, profileUrl: hit };
      });
      if (changed) {
        await prisma.conversation.update({
          where: { id: c.id },
          data: { participants: JSON.stringify(next) },
        });
        urlPatched++;
      }
    }

    return NextResponse.json(
      {
        ok: true,
        timestampsReset: toReset.length,
        snConvsTotal: snConvs.length,
        urlPatched,
        liNameMapSize: nameToUrl.size,
      },
      { headers: CORS },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'unknown' },
      { status: 500, headers: CORS },
    );
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
