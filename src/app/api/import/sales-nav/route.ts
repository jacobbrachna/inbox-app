import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import type { Participant } from '@/types';

// POST { items: [{ convId, name, headline?, profileUrl?, avatarUrl?,
//                  lastMessage?, lastMessageAt?, unreadCount? }, ...] }
//
// Direct upsert path for Sales Navigator inbox scrapes. Bypasses the
// LinkedIn-shape transform — we just need name, preview, time, and a stable
// id. Each item becomes a Conversation row tagged source='sales_nav'. We do
// NOT touch existing messages or break archive/snooze state on re-imports.

interface Item {
  convId: string;
  name: string;
  headline?: string;
  profileUrl?: string;
  avatarUrl?: string;
  lastMessage?: string;
  // ISO string when we could parse it. null when extension saw a time label
  // but couldn't interpret it — we map to epoch so the conv sorts to bottom
  // rather than crowding "Recent".
  lastMessageAt?: string | null;
  unreadCount?: number;
}

const EPOCH = new Date(0);

function normalizeName(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')         // strip diacritics
    .replace(/,.*$/, '')                       // strip ", MBA" etc.
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build a name → profileUrl lookup from existing LinkedIn-source convs that
// already have URLs (CSV import + harvest). Used to backfill SN convs by name
// so the user doesn't lose URL coverage when SN convs crowd in.
async function buildNameToUrl(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const liConvs = await prisma.conversation.findMany({
    where: {
      source: 'linkedin',
      participants: { contains: 'linkedin.com/in/' },
    },
    select: { participants: true },
  });
  for (const c of liConvs) {
    let parts: Array<{ name?: string; profileUrl?: string }> = [];
    try { parts = JSON.parse(c.participants); } catch { continue; }
    for (const p of parts) {
      if (!p?.name || !p?.profileUrl) continue;
      if (!p.profileUrl.includes('linkedin.com/in/')) continue;
      const key = normalizeName(p.name);
      if (!key) continue;
      if (!map.has(key)) map.set(key, p.profileUrl);
    }
  }
  return map;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const items: Item[] = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) {
      return NextResponse.json({ ok: true, processed: 0 }, { headers: CORS });
    }

    const nameToUrl = await buildNameToUrl();

    let created = 0;
    let updated = 0;
    let urlBackfilled = 0;
    for (const it of items) {
      // SN sync doesn't carry profileUrl. If we have a name match from
      // LinkedIn-export contacts, use that.
      if (!it.profileUrl) {
        const hit = nameToUrl.get(normalizeName(it.name));
        if (hit) {
          it.profileUrl = hit;
          urlBackfilled++;
        }
      }
      if (!it.convId || !it.name) continue;
      const participant: Participant = {
        id: it.profileUrl ?? it.convId,
        name: it.name,
        ...(it.headline ? { headline: it.headline } : {}),
        ...(it.avatarUrl ? { avatarUrl: it.avatarUrl } : {}),
        ...(it.profileUrl ? { profileUrl: it.profileUrl } : {}),
      };
      // null/undefined → epoch. Time the extension actually parsed wins — even
      // if it's older than what we have stored — because we now trust the
      // scraped DOM time over our own placeholder.
      const lastMessageAt =
        it.lastMessageAt === null || it.lastMessageAt === undefined
          ? EPOCH
          : new Date(it.lastMessageAt);

      const existing = await prisma.conversation.findUnique({ where: { id: it.convId } });
      if (existing) {
        const data: Record<string, unknown> = {};
        if (it.lastMessage) data.lastMessage = it.lastMessage;
        // Always overwrite — scraped DOM time is authoritative for SN. The
        // SN messages endpoint will later refine this with real message times.
        data.lastMessageAt = lastMessageAt;
        if (typeof it.unreadCount === 'number' && it.unreadCount !== existing.unreadCount) {
          data.unreadCount = it.unreadCount;
        }
        // If we just learned a profileUrl via the CSV name match, fold it
        // into the existing participants array (preserve everything else).
        if (it.profileUrl) {
          try {
            const parts: Participant[] = JSON.parse(existing.participants);
            let changed = false;
            const next = parts.map((p) => {
              if (!p?.profileUrl && p?.name === it.name) {
                changed = true;
                return { ...p, profileUrl: it.profileUrl };
              }
              return p;
            });
            if (changed) data.participants = JSON.stringify(next);
          } catch {}
        }
        if (Object.keys(data).length > 0) {
          await prisma.conversation.update({ where: { id: it.convId }, data });
          updated++;
        }
      } else {
        await prisma.conversation.create({
          data: {
            id: it.convId,
            source: 'sales_nav',
            participants: JSON.stringify([participant]),
            lastMessage: it.lastMessage ?? '',
            lastMessageAt,
            unreadCount: typeof it.unreadCount === 'number' ? it.unreadCount : 0,
            status: (it.unreadCount ?? 0) > 0 ? 'unread' : 'read',
            isStarred: false,
            labels: '[]',
          },
        });
        created++;
      }
    }

    return NextResponse.json(
      { ok: true, created, updated, urlBackfilled, processed: items.length },
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
