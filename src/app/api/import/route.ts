import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { transformConversations, transformMessages } from '@/lib/transform';
import { CORS, safeParseArray, optionsResponse } from '@/lib/api-utils';
import type { Conversation, Message } from '@/types';

// LinkedIn AttributedText: { text: "..." } or just a string
function readText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string') {
    return (v as { text: string }).text;
  }
  return '';
}

// Merge incoming participants with existing ones, preserving fields that
// realtime LinkedIn responses tend to drop (profileUrl/headline/avatarUrl).
// Match by id (URN) first, then by normalized name. This is the safety net
// against "/api/import wipes profileUrl every time a new message arrives."
function normalizeNameKey(s: string): string {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').trim();
}
type Participant = {
  id?: string; name?: string; headline?: string;
  avatarUrl?: string; profileUrl?: string;
};
function mergeParticipants(
  incoming: Participant[],
  existing: Participant[],
): Participant[] {
  if (!Array.isArray(incoming) || incoming.length === 0) return existing;
  if (!Array.isArray(existing) || existing.length === 0) return incoming;

  return incoming.map((inc) => {
    const incId = inc.id || '';
    const incNameKey = normalizeNameKey(inc.name || '');
    const match = existing.find((e) => {
      if (incId && e.id && incId === e.id) return true;
      if (incNameKey && normalizeNameKey(e.name || '') === incNameKey) return true;
      return false;
    });
    if (!match) return inc;
    return {
      ...inc,
      // Prefer incoming when present, fall back to existing — this preserves
      // backfilled URLs/headlines that voyager messaging responses don't carry.
      profileUrl: inc.profileUrl || match.profileUrl,
      headline: inc.headline || match.headline,
      avatarUrl: inc.avatarUrl || match.avatarUrl,
    };
  });
}

// Extract participant info from a raw message's `actor` field. Messages always
// carry the full sender record — far more reliable than conversation
// participants which sometimes arrive as bare URN references.
function participantFromMessage(rawMsg: unknown, myProfileUrn: string): {
  id: string; name: string; headline?: string; avatarUrl?: string; profileUrl?: string;
} | null {
  const r = (rawMsg ?? {}) as Record<string, unknown>;
  const actor = (r.actor ?? r.sender) as Record<string, unknown> | undefined;
  if (!actor || typeof actor !== 'object') return null;

  const hostUrn = typeof actor.hostIdentityUrn === 'string' ? actor.hostIdentityUrn : '';
  if (!hostUrn) return null;
  if (myProfileUrn && hostUrn === myProfileUrn) return null;

  const participantType = actor.participantType as Record<string, unknown> | undefined;
  const member = (participantType?.member ?? {}) as Record<string, unknown>;

  const first = readText(member.firstName);
  const last = readText(member.lastName);
  const name = `${first} ${last}`.trim() || 'LinkedIn User';

  // Avatar: profilePicture is a VectorImage with rootUrl + artifacts
  const pic = member.profilePicture as Record<string, unknown> | undefined;
  let avatarUrl: string | undefined;
  if (pic && typeof pic.rootUrl === 'string') {
    const arts = Array.isArray(pic.artifacts) ? pic.artifacts : [];
    const a = arts[arts.length - 1] as Record<string, unknown> | undefined;
    if (a && typeof a.fileIdentifyingUrlPathSegment === 'string') {
      avatarUrl = pic.rootUrl + a.fileIdentifyingUrlPathSegment;
    }
  }

  return {
    id: hostUrn,
    name,
    headline: readText(member.headline) || undefined,
    profileUrl: typeof member.profileUrl === 'string' ? member.profileUrl : undefined,
    avatarUrl,
  };
}

// Scan a captured entities dict for profile entities carrying a
// publicIdentifier slug. For every match, patch any existing conversation
// participant whose URN matches and is missing a profileUrl. Idempotent +
// safe to call on every import.
async function backfillProfileUrlsFromEntities(entities: Record<string, unknown>) {
  // Collect URN → slug from any profile-shaped entity
  const slugByUrn = new Map<string, string>();
  for (const [urn, ent] of Object.entries(entities)) {
    if (!urn || typeof urn !== 'string') continue;
    if (!urn.includes('fsd_profile') && !urn.includes('miniProfile')) continue;
    const e = ent as Record<string, unknown> | null;
    if (!e || typeof e !== 'object') continue;
    const directSlug = typeof e.publicIdentifier === 'string' ? e.publicIdentifier : null;
    const mini = (e.miniProfile as Record<string, unknown> | undefined) || {};
    const miniSlug = typeof mini.publicIdentifier === 'string' ? mini.publicIdentifier : null;
    const slug = directSlug || miniSlug;
    if (slug) slugByUrn.set(urn, slug);
  }
  if (slugByUrn.size === 0) return;

  let totalPatched = 0;
  // For each profile URN, find convs whose stored JSON contains that URN
  // and patch the matching participant.
  for (const [urn, slug] of slugByUrn) {
    const matches = await prisma.conversation.findMany({
      where: { participants: { contains: urn } },
      select: { id: true, participants: true },
    });
    for (const c of matches) {
      let parts: Array<{ id?: string; profileUrl?: string }> = [];
      try { parts = JSON.parse(c.participants); } catch { continue; }
      let changed = false;
      const next = parts.map((p) => {
        if (p?.profileUrl) return p;
        if (typeof p?.id !== 'string') return p;
        // Match if participant.id contains the URN's inner ID
        const innerId = urn.split(':').pop() || '';
        if (p.id === urn || (innerId && p.id.includes(innerId))) {
          changed = true;
          return { ...p, profileUrl: `https://www.linkedin.com/in/${slug}/` };
        }
        return p;
      });
      if (changed) {
        await prisma.conversation.update({
          where: { id: c.id },
          data: { participants: JSON.stringify(next) },
        });
        totalPatched++;
      }
    }
  }
  // Diagnostic — appears in sync log so we can confirm passive backfill works
  if (totalPatched > 0 || slugByUrn.size > 0) {
    const payload = {
      src: 'server',
      ev: 'enrich.passiveBackfill',
      profilesSeen: slugByUrn.size,
      participantsPatched: totalPatched,
    };
    // Use absolute URL since we may not have the request context
    try {
      await fetch('http://localhost:3030/api/sync-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {}
  }
}

// Persist a typed Conversation to the DB, preserving user-set fields.
// `sourceCategory` (when known) is LinkedIn's authoritative archive/inbox state
// for the conv — passes through bridge poll → import to mirror archive both ways.
async function upsertConversation(c: Conversation, raw?: unknown, sourceCategory?: string) {
  const existing = await prisma.conversation.findUnique({ where: { id: c.id } });
  const participantsJson = JSON.stringify(c.participants ?? []);
  const incomingLabels = Array.isArray(c.labels) ? c.labels : [];
  const lastMessageAt = c.lastMessageAt ? new Date(c.lastMessageAt) : new Date();
  const snoozedUntil = c.snoozedUntil ? new Date(c.snoozedUntil) : null;
  // rawData: only set if we got something with substance. Preserve existing
  // rawData if incoming is empty (refreshThread's conv objects are thin).
  const rawDataJson =
    raw && typeof raw === 'object' && Object.keys(raw as Record<string, unknown>).length > 2
      ? JSON.stringify(raw)
      : undefined;

  if (existing) {
    const existingLabels = safeParseArray<string>(existing.labels, []);
    const preservedLabels = existingLabels.length > 0 ? existingLabels : incomingLabels;
    // Archive state mirroring:
    //   - When sourceCategory is known (bridge poll), LinkedIn is authoritative:
    //       ARCHIVE → 'archived'; PRIMARY_INBOX/OTHER → flip out of 'archived'
    //       back to read/unread (preserves snoozed since LinkedIn has no snooze).
    //   - When unknown (refreshThread / realtime push / fullSync), preserve the
    //       local state — those paths don't know what category LinkedIn has it in.
    let nextStatus: string;
    if (sourceCategory === 'ARCHIVE') {
      nextStatus = 'archived';
    } else if (sourceCategory === 'PRIMARY_INBOX' || sourceCategory === 'OTHER') {
      if (existing.status === 'snoozed') {
        nextStatus = 'snoozed';
      } else if (existing.status === 'archived') {
        // LinkedIn moved it out of archive — bring it back.
        nextStatus = (c.unreadCount ?? existing.unreadCount) > 0 ? 'unread' : 'read';
      } else {
        nextStatus = c.status ?? existing.status;
      }
    } else {
      const preserveStatus = existing.status === 'archived' || existing.status === 'snoozed';
      nextStatus = preserveStatus ? existing.status : (c.status ?? existing.status);
    }

    // Only overwrite lastMessage if the incoming value is non-empty AND
    // newer than what we have — prevents the flicker where refreshThread
    // (no preview embedded) wipes a good preview written by refreshNow.
    const incomingHasPreview = !!(c.lastMessage && c.lastMessage.trim());
    const incomingIsNewer =
      !!c.lastMessageAt &&
      new Date(c.lastMessageAt).getTime() >= existing.lastMessageAt.getTime();

    // Only replace participants if INCOMING has REAL names. Stub participants
    // (name === 'LinkedIn User' or empty) must never overwrite real data —
    // that's how clicking a thread used to "wipe" the contact name.
    const incomingHasRealParticipants =
      Array.isArray(c.participants) &&
      c.participants.length > 0 &&
      c.participants.some((p) => p.name && p.name !== 'LinkedIn User');
    const existingParticipants = safeParseArray<Participant>(existing.participants, []);
    const existingHasRealParticipants =
      existingParticipants.length > 0 &&
      existingParticipants.some((p) => !!p.name && p.name !== 'LinkedIn User');
    // When taking incoming participants, merge fields from existing so that
    // backfilled profileUrl/headline/avatarUrl survive a realtime overwrite.
    let finalParticipants: string;
    if (incomingHasRealParticipants || !existingHasRealParticipants) {
      if (Array.isArray(c.participants) && c.participants.length > 0) {
        const merged = mergeParticipants(c.participants as Participant[], existingParticipants);
        finalParticipants = JSON.stringify(merged);
      } else {
        finalParticipants = existing.participants;
      }
    } else {
      finalParticipants = existing.participants;
    }

    await prisma.conversation.update({
      where: { id: c.id },
      data: {
        source: c.source ?? existing.source,
        participants: finalParticipants,
        lastMessage: incomingHasPreview && incomingIsNewer ? c.lastMessage : existing.lastMessage,
        lastMessageAt: incomingIsNewer ? lastMessageAt : existing.lastMessageAt,
        unreadCount: typeof c.unreadCount === 'number' ? c.unreadCount : existing.unreadCount,
        status: nextStatus,
        isStarred: existing.isStarred,
        snoozedUntil: existing.snoozedUntil ?? snoozedUntil,
        labels: JSON.stringify(preservedLabels),
        ...(rawDataJson ? { rawData: rawDataJson } : {}),
      },
    });
  } else {
    // New conv: respect sourceCategory if provided (so archived threads
    // discovered via the ARCHIVE poll arrive as archived).
    const newStatus =
      sourceCategory === 'ARCHIVE' ? 'archived' : (c.status ?? 'read');
    await prisma.conversation.create({
      data: {
        id: c.id,
        source: c.source ?? 'linkedin',
        participants: participantsJson,
        lastMessage: c.lastMessage ?? '',
        lastMessageAt,
        unreadCount: c.unreadCount ?? 0,
        status: newStatus,
        isStarred: c.isStarred ?? false,
        snoozedUntil,
        labels: JSON.stringify(incomingLabels),
        rawData: rawDataJson ?? null,
      },
    });
  }
}

// Upsert messages by ID. NEW messages are inserted; EXISTING messages have
// their senderName/isFromMe updated if the incoming version has better data
// (e.g. fresh fetch from LinkedIn now has the real name where DB has stub).
//
// Trust transformMessages — it extracted the sender from the message's `actor`
// field which always carries the canonical name. No post-write attribution.
async function upsertMessages(
  conversationId: string,
  items: Array<Message & { _raw?: unknown }>,
) {
  const valid = items.filter((m) => m && typeof m.id === 'string');
  if (valid.length === 0) return;

  const existing = await prisma.message.findMany({
    where: {
      conversationId,
      id: { in: valid.map((m) => m.id) },
    },
    select: { id: true, senderName: true, isFromMe: true },
  });
  type MsgWithRaw = Message & { _raw?: unknown };
  const existingById = new Map(existing.map((e) => [e.id, e]));
  const toInsert: MsgWithRaw[] = [];
  const toUpdate: MsgWithRaw[] = [];

  for (const m of valid) {
    const ex = existingById.get(m.id);
    if (!ex) {
      toInsert.push(m);
      continue;
    }
    // Update existing only when senderName improves (was placeholder/empty,
    // now is a real name) or isFromMe flag flipped.
    const incomingHasRealName = !!m.senderName && m.senderName !== 'LinkedIn User';
    const existingHasRealName = !!ex.senderName && ex.senderName !== 'LinkedIn User';
    const flagChanged = !!m.isFromMe !== ex.isFromMe;
    if ((incomingHasRealName && !existingHasRealName) || flagChanged) {
      toUpdate.push(m);
    }
  }

  if (toInsert.length > 0) {
    await prisma.message.createMany({
      data: toInsert.map((m) => ({
        id: m.id,
        conversationId,
        senderId: m.senderId ?? '',
        senderName: m.senderName ?? '',
        body: m.body ?? '',
        sentAt: m.sentAt ? new Date(m.sentAt) : new Date(),
        isFromMe: !!m.isFromMe,
        rawData: m._raw ? JSON.stringify(m._raw) : null,
      })),
    });
  }

  for (const m of toUpdate) {
    await prisma.message.update({
      where: { id: m.id },
      data: { senderName: m.senderName ?? '', isFromMe: !!m.isFromMe },
    });
  }

  // Bump the conversation's last-activity fields based on the newest message
  // (so the UI's auto-refresh poll detects the change and reloads).
  const considered = toInsert.length > 0 ? toInsert : toUpdate;
  if (considered.length > 0) {
    const newest = considered.reduce((a, b) =>
      new Date(a.sentAt).getTime() > new Date(b.sentAt).getTime() ? a : b,
    );
    const newestSentAt = new Date(newest.sentAt);
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { lastMessageAt: true, lastMessage: true, status: true },
    });
    if (conv) {
      const isNewer = newestSentAt >= conv.lastMessageAt;
      const previewIsMissing = !conv.lastMessage || !conv.lastMessage.trim();
      const shouldUpdate = isNewer || previewIsMissing;
      if (shouldUpdate && newest.body) {
        // DON'T auto-mark unread here. During bulk loads we'd flip every conv
        // with historical inbound messages to "unread". LinkedIn's own
        // `unreadCount`/`read` fields (set during upsertConversation) are the
        // authoritative source — let those drive unread state.
        await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            lastMessageAt: isNewer ? newestSentAt : conv.lastMessageAt,
            lastMessage: newest.body,
          },
        });
      }
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const rawConvs: Array<Record<string, unknown>> = Array.isArray(body.conversations)
      ? body.conversations
      : Array.isArray(body.elements)
        ? body.elements
        : [];
    const rawMsgs: Record<string, unknown[]> =
      body.messages && typeof body.messages === 'object' && !Array.isArray(body.messages)
        ? body.messages
        : {};
    const entities: Record<string, unknown> =
      body.entities && typeof body.entities === 'object' && !Array.isArray(body.entities)
        ? body.entities
        : {};
    const myProfileUrn = typeof body.myProfileUrn === 'string' ? body.myProfileUrn : '';

    // Run the well-tested transform server-side.
    const ctx = { entities, myProfileUrn };
    const liRaw = rawConvs.filter((c) => c._src !== 'sn');
    const snRaw = rawConvs.filter((c) => c._src === 'sn');
    const conversations: Conversation[] = [
      ...transformConversations(liRaw, 'linkedin', ctx),
      ...transformConversations(snRaw, 'sales_nav', ctx),
    ];

    // Backfill conversation participants from message actors when missing.
    // The realtime flow's conv objects often lack participant data; messages
    // always carry full actor info. This guarantees real names instead of
    // "LinkedIn User" the moment a message arrives.
    for (const conv of conversations) {
      const hasGoodParticipants =
        Array.isArray(conv.participants) &&
        conv.participants.length > 0 &&
        conv.participants.some((p) => p.name && p.name !== 'LinkedIn User');
      if (hasGoodParticipants) continue;
      const msgs = rawMsgs[conv.id];
      if (!Array.isArray(msgs) || msgs.length === 0) continue;
      const seen = new Set<string>();
      const fromMessages: Conversation['participants'] = [];
      for (const m of msgs) {
        const p = participantFromMessage(m, myProfileUrn);
        if (!p) continue;
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        fromMessages.push(p);
      }
      if (fromMessages.length > 0) {
        conv.participants = fromMessages;
      }
    }

    // Extract my display name from the entities map (used for AppState only —
    // sender attribution comes from each message's `actor` field via
    // transformMessages, not from this).
    const existingState = await prisma.appState.findUnique({ where: { id: 1 } });
    let myName = existingState?.profileName ?? '';
    if (!myName && myProfileUrn && entities[myProfileUrn]) {
      const meEntity = entities[myProfileUrn] as Record<string, unknown>;
      const fn = (meEntity.firstName as { text?: string } | string | undefined);
      const ln = (meEntity.lastName as { text?: string } | string | undefined);
      const first = typeof fn === 'string' ? fn : fn?.text ?? '';
      const last = typeof ln === 'string' ? ln : ln?.text ?? '';
      if (first || last) myName = `${first} ${last}`.trim();
    }
    if (!myName) myName = 'Me';

    // Build a map of conv URN → raw conversation object from the request body
    // (we passed transformed Conversation objects but want the raw alongside).
    // Also extract the source category (PRIMARY_INBOX / OTHER / ARCHIVE) which
    // the bridge poll tags onto each conv so we can mirror LinkedIn's archive
    // state back to InboxPro.
    const rawConvByUrn = new Map<string, unknown>();
    const categoryByConvUrn = new Map<string, string>();
    for (const rc of rawConvs) {
      const urn = typeof rc.entityUrn === 'string' ? rc.entityUrn : null;
      if (urn) {
        rawConvByUrn.set(urn, rc);
        const cat = typeof rc._sourceCategory === 'string' ? rc._sourceCategory : '';
        if (cat) categoryByConvUrn.set(urn, cat);
      }
    }

    // Write conversations first so message FKs resolve.
    for (const c of conversations) {
      await upsertConversation(c, rawConvByUrn.get(c.id), categoryByConvUrn.get(c.id));
    }

    // ── Passive enrichment via captured entities ─────────────────────────
    // Whenever LinkedIn's own UI fetches a profile (you click an avatar,
    // visit a profile page, search), the response is captured by injected.js
    // and forwarded here in `entities`. Profile entities include the public
    // slug we need to render a /in/<slug>/ URL. We patch any existing
    // participant whose URN matches and is missing a profileUrl.
    await backfillProfileUrlsFromEntities(entities);

    // Build the set of conversation IDs whose messages we need to process.
    const knownConvIds = new Set<string>(conversations.map((c) => c.id));
    for (const urn of Object.keys(rawMsgs)) {
      if (knownConvIds.has(urn)) continue;
      const existing = await prisma.conversation.findUnique({ where: { id: urn }, select: { id: true, participants: true } });

      // Extract participants from the raw messages — used for stub creation
      // OR to backfill an existing row whose participants are weak.
      const msgs = rawMsgs[urn] || [];
      const seen = new Set<string>();
      const fromMessages: Array<{ id: string; name: string; headline?: string; profileUrl?: string; avatarUrl?: string }> = [];
      for (const m of msgs) {
        const p = participantFromMessage(m, myProfileUrn);
        if (!p) continue;
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        fromMessages.push(p);
      }
      const participantsJson = JSON.stringify(fromMessages);

      if (existing) {
        knownConvIds.add(urn);
        // If existing row has no real participants, fill from messages now
        const existingParts = safeParseArray<{ name?: string }>(existing.participants, []);
        const isWeak = existingParts.length === 0 || existingParts.every((p) => !p.name || p.name === 'LinkedIn User');
        if (isWeak && fromMessages.length > 0) {
          await prisma.conversation.update({
            where: { id: urn },
            data: { participants: participantsJson },
          });
        }
        continue;
      }

      // New row — create stub WITH participants populated from message actors
      try {
        await prisma.conversation.create({
          data: {
            id: urn,
            source: 'linkedin',
            participants: participantsJson,
            lastMessage: '',
            lastMessageAt: new Date(),
            unreadCount: 0,
            status: 'unread',
            isStarred: false,
            labels: '[]',
            notes: '',
          },
        });
        knownConvIds.add(urn);
      } catch (e) {
        console.warn('[import] could not create stub conversation for', urn, e);
      }
    }

    let totalMsgs = 0;
    for (const convId of knownConvIds) {
      const raw = rawMsgs[convId];
      if (!Array.isArray(raw) || raw.length === 0) continue;

      // Look up the conv's participants to use as a fallback name source.
      // LinkedIn's actor doesn't always include member data on every message,
      // so transformMessages can produce "LinkedIn User" senderNames even
      // when we DO know who the other party is from the conversation row.
      const convRow = await prisma.conversation.findUnique({
        where: { id: convId },
        select: { participants: true },
      });
      const convParticipants = safeParseArray<{ id?: string; name?: string }>(
        convRow?.participants ?? '[]',
        [],
      );
      function findParticipantNameForSender(senderId: string): string | null {
        if (!senderId) return null;
        for (const p of convParticipants) {
          if (!p.name || p.name === 'LinkedIn User') continue;
          if (!p.id) continue;
          // senderId is often `urn:li:msg_messagingParticipant:urn:li:fsd_profile:XXX`
          // and the participant id is `urn:li:fsd_profile:XXX` (or vice versa)
          if (senderId === p.id || senderId.includes(p.id) || p.id.includes(senderId)) {
            return p.name;
          }
        }
        return null;
      }

      const transformed = transformMessages(raw, myProfileUrn, ctx);
      // Build a map of message URN → raw object so we can attach raw data
      // alongside each transformed message.
      const rawByUrn = new Map<string, unknown>();
      for (const rm of raw) {
        const rmObj = rm as Record<string, unknown>;
        const u = typeof rmObj?.entityUrn === 'string' ? rmObj.entityUrn : null;
        if (u) rawByUrn.set(u, rm);
      }

      const items = transformed
        .map((m) => {
          let senderName = m.senderName;
          if (m.isFromMe && (!senderName || senderName === 'LinkedIn User')) {
            senderName = myName;
          }
          if (!m.isFromMe && (!senderName || senderName === 'LinkedIn User')) {
            const fallback = findParticipantNameForSender(m.senderId);
            if (fallback) senderName = fallback;
          }
          return {
            ...m,
            conversationId: convId,
            senderName,
            _raw: rawByUrn.get(m.id),
          };
        })
        .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
      await upsertMessages(convId, items);
      totalMsgs += items.length;
    }

    // Update lastSyncedAt + profile name
    await prisma.appState.upsert({
      where: { id: 1 },
      update: {
        lastSyncedAt: new Date(),
        myProfileUrn: myProfileUrn || undefined,
        profileName: myName !== 'Me' ? myName : undefined,
      },
      create: {
        id: 1,
        lastSyncedAt: new Date(),
        myProfileUrn: myProfileUrn || undefined,
        profileName: myName !== 'Me' ? myName : undefined,
      },
    });

    console.log(
      '[import] persisted',
      conversations.length,
      'conversations,',
      totalMsgs,
      'messages',
    );

    return NextResponse.json(
      { ok: true, conversations: conversations.length, messages: totalMsgs },
      { headers: CORS },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[import] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
