import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { linkParticipantsToConversation } from '@/lib/contact-upsert';

// POST { body: string } — raw JSON from /sales-api/salesApiMessagingThreads.
// Shape (verified from a real response in sn-samples/live-*.json):
//   {
//     data: {
//       elements: [ { id, messages, participants, participantsResolutionResults, ... } ],
//       paging: {...}
//     },
//     included: [
//       { entityUrn: "urn:li:fs_salesProfile:...",
//         firstName, lastName, fullName, profilePictureDisplayImage, ... }
//     ]
//   }
// Each message's `author` is a URN string that references an entry in
// included[]. We build a URN→Profile lookup table once per request.

type Profile = {
  entityUrn?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  profilePictureDisplayImage?: {
    rootUrl?: string;
    artifacts?: Array<{ fileIdentifyingUrlPathSegment?: string }>;
  };
};

type SnMessage = {
  id?: string;
  author?: string;
  body?: string;
  deliveredAt?: number;
  type?: string;
};

type SnThread = {
  id?: string;
  participants?: string[];
  messages?: SnMessage[];
  unreadMessageCount?: number;
  archived?: boolean;
  totalMessageCount?: number;
};

function buildProfileMap(included: unknown): Map<string, Profile> {
  const map = new Map<string, Profile>();
  if (!Array.isArray(included)) return map;
  for (const item of included) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Profile;
    if (typeof p.entityUrn === 'string') map.set(p.entityUrn, p);
  }
  return map;
}

function avatarFromProfile(p: Profile | undefined): string {
  if (!p?.profilePictureDisplayImage) return '';
  const arts = p.profilePictureDisplayImage.artifacts;
  if (!Array.isArray(arts) || arts.length === 0) return '';
  // Pick smallest (100x100) — that's the inbox display size
  const seg = arts[0]?.fileIdentifyingUrlPathSegment;
  if (typeof seg !== 'string') return '';
  // SN returns absolute URL in segment when rootUrl is empty
  const root = p.profilePictureDisplayImage.rootUrl ?? '';
  return root + seg;
}

function fullNameOf(p: Profile | undefined): string {
  if (!p) return '';
  if (p.fullName) return p.fullName;
  const a = p.firstName ?? '';
  const b = p.lastName ?? '';
  return `${a} ${b}`.trim();
}

type Participant = {
  id?: string; name?: string; headline?: string;
  avatarUrl?: string; profileUrl?: string;
};

// Update the conv's stored participant with the OTHER party's avatar (and
// name if it's missing). Headline isn't in this response — that comes from a
// different SN endpoint we'll intercept later.
function patchConvParticipants(
  participantsJson: string,
  otherProfile: Profile | undefined,
): string | null {
  if (!otherProfile) return null;
  const otherName = fullNameOf(otherProfile);
  const otherAvatar = avatarFromProfile(otherProfile);
  if (!otherName && !otherAvatar) return null;
  let parts: Participant[] = [];
  try { parts = JSON.parse(participantsJson); } catch { return null; }
  let changed = false;
  const next = parts.map((p) => {
    if (!p) return p;
    // Match on URN id when both have it, else by name
    const matches =
      (p.id === otherProfile.entityUrn) ||
      (otherName && p.name && p.name.toLowerCase() === otherName.toLowerCase());
    if (!matches) return p;
    const merged = { ...p };
    if (!p.avatarUrl && otherAvatar) { merged.avatarUrl = otherAvatar; changed = true; }
    if (!p.name && otherName) { merged.name = otherName; changed = true; }
    return merged;
  });
  return changed ? JSON.stringify(next) : null;
}

// Dump the first non-trivial body so we have a reference sample for the shape.
let _dumpedSample = false;
async function dumpSampleOnce(rawBody: string) {
  if (_dumpedSample) return;
  _dumpedSample = true;
  try {
    const { promises: fs } = await import('fs');
    const path = await import('path');
    const dir = path.join(process.cwd(), 'sn-samples');
    await fs.mkdir(dir, { recursive: true });
    const fp = path.join(dir, `live-${Date.now()}.json`);
    await fs.writeFile(fp, rawBody, 'utf8');
  } catch {}
}

export async function POST(req: NextRequest) {
  try {
    const { body: rawBody } = await req.json();
    if (typeof rawBody !== 'string') {
      return NextResponse.json({ error: 'body required' }, { status: 400, headers: CORS });
    }
    if (rawBody.length > 1000) dumpSampleOnce(rawBody);

    let payload: { data?: { elements?: SnThread[] }; included?: unknown };
    try { payload = JSON.parse(rawBody); }
    catch (e) {
      return NextResponse.json(
        { error: 'JSON parse failed: ' + (e instanceof Error ? e.message : 'unknown') },
        { status: 400, headers: CORS },
      );
    }

    const threads = payload?.data?.elements;
    if (!Array.isArray(threads) || threads.length === 0) {
      const rootKeys = payload && typeof payload === 'object'
        ? Object.keys(payload).slice(0, 12) : [];
      return NextResponse.json(
        { ok: false, reason: 'no data.elements', rootKeys, bytes: rawBody.length },
        { headers: CORS },
      );
    }

    const profileMap = buildProfileMap(payload.included);

    const state = await prisma.appState.findUnique({ where: { id: 1 } });
    const myUrn = state?.myProfileUrn ?? '';
    const myName = (state?.profileName ?? '').toLowerCase();

    let convsTouched = 0;
    let convsNotFound = 0;
    let messagesFound = 0;
    let inserted = 0;
    let convsHeadlined = 0; // we patch avatar+name even when no headline

    for (const t of threads) {
      if (!t?.id) continue;
      const convId = `sn:${t.id}`;
      let conv = await prisma.conversation.findUnique({ where: { id: convId } });
      if (!conv) {
        // New thread we haven't seen before — create the conv shell using the
        // first non-me participant from the response. The parser body below
        // will then populate messages + headline as usual.
        let primary: Profile | undefined;
        if (Array.isArray(t.participants)) {
          for (const purn of t.participants) {
            if (typeof purn !== 'string') continue;
            // Skip "me" — match by URN substring overlap OR name
            const cand = profileMap.get(purn);
            const candName = fullNameOf(cand);
            const isMe =
              (!!myUrn && (purn === myUrn || purn.includes(myUrn) || myUrn.includes(purn))) ||
              (myName !== '' && candName.toLowerCase() === myName);
            if (isMe) continue;
            primary = cand;
            if (primary) break;
          }
        }
        if (!primary) {
          // No resolvable participant — skip rather than create a nameless row
          convsNotFound++;
          continue;
        }
        const participant: Participant = {
          id: primary.entityUrn ?? convId,
          name: fullNameOf(primary) || 'Unknown',
          ...(avatarFromProfile(primary) ? { avatarUrl: avatarFromProfile(primary) } : {}),
        };
        conv = await prisma.conversation.create({
          data: {
            id: convId,
            source: 'sales_nav',
            participants: JSON.stringify([participant]),
            lastMessage: '',
            lastMessageAt: new Date(0),
            unreadCount: typeof t.unreadMessageCount === 'number' ? t.unreadMessageCount : 0,
            status: (t.unreadMessageCount ?? 0) > 0 ? 'unread' : 'read',
            isStarred: false,
            labels: '[]',
          },
        });
        await linkParticipantsToConversation(convId, [participant], null);
      }
      convsTouched++;

      const rawMsgs = Array.isArray(t.messages) ? t.messages : [];
      messagesFound += rawMsgs.length;

      let participantsJson = conv.participants;
      let newestSentAt: Date | null = null;
      let newestBody = '';

      for (const m of rawMsgs) {
        if (!m?.id || !m.body) continue;
        const authorUrn = m.author ?? '';
        const authorProfile = authorUrn ? profileMap.get(authorUrn) : undefined;
        const senderName = fullNameOf(authorProfile) || 'Unknown';
        // SN URNs (fs_salesProfile) differ from LinkedIn URNs (fsd_profile),
        // so URN equality alone misses the user's own outbound messages.
        // Fall back to name match against AppState.profileName.
        const isFromMe =
          (!!myUrn && !!authorUrn && (
            authorUrn === myUrn ||
            authorUrn.includes(myUrn) ||
            myUrn.includes(authorUrn)
          )) ||
          (myName !== '' && senderName.toLowerCase() === myName);
        const sentAt = new Date(m.deliveredAt ?? Date.now());

        try {
          await prisma.message.upsert({
            where: { id: `sn-msg:${m.id}` },
            create: {
              id: `sn-msg:${m.id}`,
              conversationId: convId,
              senderId: authorUrn,
              senderName,
              body: m.body,
              sentAt,
              isFromMe,
              rawData: JSON.stringify(m),
            },
            update: { body: m.body, senderName, isFromMe },
          });
          inserted++;
        } catch {}

        if (!isFromMe) {
          // Patch participant with author profile (avatar at minimum)
          const patched = patchConvParticipants(participantsJson, authorProfile);
          if (patched) { participantsJson = patched; convsHeadlined++; }
        }

        if (!newestSentAt || sentAt > newestSentAt) {
          newestSentAt = sentAt;
          newestBody = m.body;
        }
      }

      // Also patch with the OTHER thread participant (in case latest message
      // is from us — we still want the contact's avatar).
      if (Array.isArray(t.participants)) {
        for (const purn of t.participants) {
          if (typeof purn !== 'string') continue;
          if (myUrn && (purn === myUrn || purn.includes(myUrn))) continue;
          const op = profileMap.get(purn);
          if (op) {
            const patched = patchConvParticipants(participantsJson, op);
            if (patched) { participantsJson = patched; convsHeadlined++; }
          }
        }
      }

      const data: Record<string, unknown> = {};
      if (participantsJson !== conv.participants) data.participants = participantsJson;
      if (typeof t.unreadMessageCount === 'number' && t.unreadMessageCount !== conv.unreadCount) {
        data.unreadCount = t.unreadMessageCount;
        data.status = t.unreadMessageCount > 0 ? 'unread' : 'read';
      }
      if (t.archived === true && conv.status !== 'archived') data.status = 'archived';
      if (newestSentAt && newestSentAt > conv.lastMessageAt) {
        data.lastMessage = newestBody.slice(0, 500);
        data.lastMessageAt = newestSentAt;
      }
      if (Object.keys(data).length > 0) {
        await prisma.conversation.update({ where: { id: convId }, data });
      }
    }

    return NextResponse.json(
      {
        ok: true,
        threadsFound: threads.length,
        convsTouched,
        convsNotFound,
        messagesFound,
        inserted,
        convsHeadlined,
        profileMapSize: profileMap.size,
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
