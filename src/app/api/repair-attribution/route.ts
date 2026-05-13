import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// Re-derive isFromMe + senderId + senderName from each message's stored
// rawData. Trusts raw.sender.hostIdentityUrn over raw.actor.hostIdentityUrn
// — that's the authoritative sender (actor can point to the recipient for
// connection-request intros).
export async function POST() {
  const appState = await prisma.appState.findUnique({ where: { id: 1 } });
  const myUrn = appState?.myProfileUrn ?? '';
  const myName = appState?.profileName ?? 'Me';
  if (!myUrn) {
    return NextResponse.json({ error: 'no myProfileUrn' }, { status: 400, headers: CORS });
  }

  // Build a profile URN → display name map from conversation participants
  const convs = await prisma.conversation.findMany({
    select: { id: true, participants: true },
  });
  const nameByProfileUrn = new Map<string, string>();
  for (const c of convs) {
    try {
      const parts: Array<{ id?: string; name?: string }> = JSON.parse(c.participants);
      for (const p of parts) {
        if (!p?.id || !p?.name || p.name === 'LinkedIn User') continue;
        // Extract fsd_profile URN from messagingParticipant URN
        const m = p.id.match(/urn:li:fsd_profile:[A-Za-z0-9_-]+/);
        if (m) nameByProfileUrn.set(m[0], p.name);
      }
    } catch {}
  }

  const messages = await prisma.message.findMany({
    select: { id: true, conversationId: true, rawData: true, senderName: true, senderId: true, isFromMe: true },
    where: { rawData: { not: null } },
  });

  let updated = 0;
  for (const m of messages) {
    if (!m.rawData) continue;
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(m.rawData); } catch { continue; }

    const senderObj = raw.sender as Record<string, unknown> | undefined;
    const actorObj = raw.actor as Record<string, unknown> | undefined;

    // AUTHORITATIVE sender: raw.sender.hostIdentityUrn
    const senderHostUrn =
      (typeof senderObj?.hostIdentityUrn === 'string' ? senderObj.hostIdentityUrn : null) ??
      (typeof actorObj?.hostIdentityUrn === 'string' ? actorObj.hostIdentityUrn : null);
    if (!senderHostUrn) continue;

    const isFromMe = senderHostUrn === myUrn || senderHostUrn.includes(myUrn) || myUrn.includes(senderHostUrn);

    // Derive senderName: if me, use myName. Otherwise try actor.member (only
    // if actor agrees with sender), then fall back to the participant map.
    let senderName = '';
    if (isFromMe) {
      senderName = myName;
    } else {
      // Try the actor's member only when actor matches the canonical sender
      const actorMatchesSender =
        senderObj?.hostIdentityUrn && actorObj?.hostIdentityUrn &&
        senderObj.hostIdentityUrn === actorObj.hostIdentityUrn;
      if (actorMatchesSender) {
        const member = (actorObj?.participantType as Record<string, unknown> | undefined)?.member as Record<string, unknown> | undefined;
        const first = (member?.firstName as { text?: string } | string | undefined);
        const last = (member?.lastName as { text?: string } | string | undefined);
        const f = typeof first === 'string' ? first : first?.text ?? '';
        const l = typeof last === 'string' ? last : last?.text ?? '';
        senderName = `${f} ${l}`.trim();
      }
      if (!senderName) {
        senderName = nameByProfileUrn.get(senderHostUrn) ?? '';
      }
      if (!senderName) senderName = 'LinkedIn User';
    }

    if (
      m.senderId !== senderHostUrn ||
      m.senderName !== senderName ||
      m.isFromMe !== isFromMe
    ) {
      await prisma.message.update({
        where: { id: m.id },
        data: {
          senderId: senderHostUrn,
          senderName,
          isFromMe,
        },
      });
      updated++;
    }
  }

  return NextResponse.json({ ok: true, updated, total: messages.length }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
