import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, safeParseArray, optionsResponse } from '@/lib/api-utils';
import type { Participant } from '@/types';

// GET /api/tasks — the Tasks hub. PEOPLE view: each row is a contact, not
// a thread. Returns:
//   newConnections — contacts you've connected to but never messaged
//   followUpsOwed  — contacts you committed to follow up with (grouped by
//                    person, soonest date wins for sorting)
//
// Thread-state surfaces (Hot / Going cold / Stale / Overdue) live in OBQ.

const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_CONNECTION_LIMIT = 100; // surface most-recent first

export interface NewConnectionItem {
  contactId: string;
  name: string;
  avatarUrl: string | null;
  profileUrl: string | null;
  headline: string | null;
  company: string | null;
  role: string | null;
  source: string | null;
  firstSeenAt: string;
  connectedOn: string | null;
}

export interface FollowUpThread {
  conversationId: string;
  followUpAt: string;
  followUpReason: string | null;
  followUpSource: string | null;
  followUpConfidence: string | null;
  daysUntilDue: number; // negative when overdue
}

export interface FollowUpContact {
  contactId: string | null;
  name: string;
  avatarUrl: string | null;
  headline: string | null;
  company: string | null;
  // Soonest follow-up date across all this contact's pending threads
  nextFollowUpAt: string;
  nextDaysUntilDue: number;
  followUps: FollowUpThread[];
}

export async function GET() {
  const now = Date.now();
  const today = new Date();
  today.setHours(23, 59, 59, 999); // include anything due "today"

  // 1. New Connections — Contacts with no outbound activity, anonymous excluded.
  // Sort by connectedOn DESC (real LinkedIn connection date) when present,
  // falling back to firstSeenAt for contacts with no CSV-export connection date.
  const newConnContacts = await prisma.contact.findMany({
    where: {
      lastOutboundAt: null,
      NOT: {
        AND: [
          { name: { in: ['LinkedIn User', 'LinkedIn Member'] } },
          { linkedinUrn: null },
          { profileSlug: null },
        ],
      },
    },
    orderBy: [
      // Prisma puts NULLs last by default in DESC, which is what we want —
      // real connection dates first, then "unknown" rows.
      { connectedOn: 'desc' },
      { firstSeenAt: 'desc' },
    ],
    take: NEW_CONNECTION_LIMIT,
    select: {
      id: true,
      name: true,
      avatarUrl: true,
      profileUrl: true,
      headline: true,
      company: true,
      role: true,
      source: true,
      firstSeenAt: true,
      connectedOn: true,
    },
  });

  const newConnections: NewConnectionItem[] = newConnContacts.map((c) => ({
    contactId: c.id,
    name: c.name,
    avatarUrl: c.avatarUrl,
    profileUrl: c.profileUrl,
    headline: c.headline,
    company: c.company,
    role: c.role,
    source: c.source,
    firstSeenAt: c.firstSeenAt.toISOString(),
    connectedOn: c.connectedOn?.toISOString() ?? null,
  }));
  const newConnectionsTotal = await prisma.contact.count({
    where: {
      lastOutboundAt: null,
      NOT: {
        AND: [
          { name: { in: ['LinkedIn User', 'LinkedIn Member'] } },
          { linkedinUrn: null },
          { profileSlug: null },
        ],
      },
    },
  });

  // 2. Follow-ups Owed — conversations with followUpAt today or earlier,
  // grouped by contact. One row per person, soonest follow-up wins for sort.
  const dueConvs = await prisma.conversation.findMany({
    where: {
      status: { not: 'archived' },
      followUpAt: { lte: today },
    },
    orderBy: { followUpAt: 'asc' },
    include: {
      contacts: {
        select: {
          contact: {
            select: {
              id: true,
              name: true,
              avatarUrl: true,
              headline: true,
              company: true,
            },
          },
        },
        take: 1,
      },
    },
  });

  // Group by contact id (fall back to conv id for orphan threads).
  const byContact = new Map<string, FollowUpContact>();
  for (const c of dueConvs) {
    const linked = c.contacts[0]?.contact ?? null;
    const parts = safeParseArray<Participant>(c.participants, []);
    const p = parts[0];
    let enrichment: { company?: string } | null = null;
    if (c.enrichment) {
      try { enrichment = JSON.parse(c.enrichment); } catch {}
    }
    const key = linked?.id ?? `conv:${c.id}`;
    const dueMs = c.followUpAt!.getTime();
    const daysUntilDue = Math.floor((dueMs - now) / DAY_MS);
    const thread: FollowUpThread = {
      conversationId: c.id,
      followUpAt: c.followUpAt!.toISOString(),
      followUpReason: c.followUpReason,
      followUpSource: c.followUpSource,
      followUpConfidence: c.followUpConfidence,
      daysUntilDue,
    };
    const existing = byContact.get(key);
    if (existing) {
      existing.followUps.push(thread);
      if (dueMs < new Date(existing.nextFollowUpAt).getTime()) {
        existing.nextFollowUpAt = thread.followUpAt;
        existing.nextDaysUntilDue = daysUntilDue;
      }
    } else {
      byContact.set(key, {
        contactId: linked?.id ?? null,
        name: linked?.name ?? p?.name ?? 'Unknown',
        avatarUrl: linked?.avatarUrl ?? p?.avatarUrl ?? null,
        headline: linked?.headline ?? p?.headline ?? null,
        company: linked?.company ?? enrichment?.company ?? null,
        nextFollowUpAt: thread.followUpAt,
        nextDaysUntilDue: daysUntilDue,
        followUps: [thread],
      });
    }
  }

  const followUpsOwed: FollowUpContact[] = Array.from(byContact.values())
    .sort((a, b) => a.nextDaysUntilDue - b.nextDaysUntilDue); // overdue first

  return NextResponse.json(
    {
      newConnections,
      newConnectionsTotal,
      followUpsOwed,
      counts: {
        newConnections: newConnectionsTotal,
        followUpsOwed: followUpsOwed.length,
      },
    },
    { headers: CORS },
  );
}

export async function OPTIONS() {
  return optionsResponse();
}
