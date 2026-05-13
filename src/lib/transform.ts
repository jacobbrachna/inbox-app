import type { Conversation, Message, Participant } from '@/types';

export interface TransformContext {
  entities?: Record<string, unknown>;
  myProfileUrn?: string;
}

// ─── Low-level safe accessors ────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  // LinkedIn AttributedText: { _type: '...AttributedText', text: '...', attributes: [] }
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string' && o.text.length > 0) return o.text;
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ─── Avatar helpers ───────────────────────────────────────────────────────────

/** Build a URL from rootUrl + artifacts array (old REST style). */
function avatarFromRootAndArtifacts(
  rootUrl: unknown,
  artifacts: unknown,
): string | undefined {
  const root = str(rootUrl);
  const arts = arr(artifacts);
  if (!root || arts.length === 0) return undefined;
  // Pick the largest artifact (last entry tends to be bigger)
  const art = obj(arts[arts.length - 1]);
  const seg = str(art?.fileIdentifyingUrlPathSegment);
  return seg ? root + seg : undefined;
}

/** Extract avatar URL from the new "vectorImage" shape. */
function avatarFromVectorImage(vi: unknown): string | undefined {
  const v = obj(vi);
  if (!v) return undefined;
  return avatarFromRootAndArtifacts(v.rootUrl, v.artifacts);
}

/** Extract avatar URL from a "photo" object (rootUrl + artifacts at top level). */
function avatarFromPhotoObj(photo: unknown): string | undefined {
  const p = obj(photo);
  if (!p) return undefined;
  // photo may itself be the vectorImage wrapper
  const vi = obj(p.vectorImage) ?? obj(p.displayImageWithDigitalAsset) ?? obj(p.cropInfo);
  if (vi) return avatarFromVectorImage(vi);
  return avatarFromRootAndArtifacts(p.rootUrl, p.artifacts);
}

// ─── Participant name extraction ──────────────────────────────────────────────

/**
 * Given the raw participant record (which can come from many LinkedIn API
 * shapes), return { firstName, lastName, name, id, headline, avatarUrl, profileUrl }.
 * Returns null only if there is truly nothing usable.
 */
// Resolve a URN string to its full entity object via the entities map
function resolveUrn(v: unknown, ctx?: TransformContext): unknown {
  if (typeof v !== 'string') return v;
  if (!ctx?.entities) return v;
  return ctx.entities[v] ?? v;
}

function extractParticipant(p: unknown, ctx?: TransformContext): Participant | null {
  const resolved = typeof p === 'string' ? resolveUrn(p, ctx) : p;
  const original = obj(resolved);
  if (!original) {
    if (typeof p === 'string') {
      return { id: p, name: 'LinkedIn User' };
    }
    return null;
  }

  // Build a working copy so we don't mutate captured entities
  const pObj: Record<string, unknown> = { ...original };

  // Resolve profile via hostIdentityUrn / participantUrn (GraphQL pattern)
  const profileUrn = str(pObj.hostIdentityUrn) ?? str(pObj.participantUrn);
  if (profileUrn) {
    const profile = obj(resolveUrn(profileUrn, ctx));
    if (profile) {
      // Merge: profile data fills in missing fields without overwriting participant fields
      for (const [k, v] of Object.entries(profile)) {
        if (pObj[k] === undefined) pObj[k] = v;
      }
    }
  }
  // Star-prefixed reference fields (Pegasus): resolve them
  for (const k of Object.keys(pObj)) {
    if (k.startsWith('*') && typeof pObj[k] === 'string') {
      const target = resolveUrn(pObj[k] as string, ctx);
      if (obj(target)) pObj[k.slice(1)] = target;
    }
  }

  // ── 1. Pre-formatted name field (some simplified formats) ─────────────────
  const directName = str(pObj.name);

  // ── 2. Resolve the member sub-object ──────────────────────────────────────
  // Try all known nesting paths, most-specific first.
  const memberCandidates: unknown[] = [
    obj(pObj.participantType)?.member,          // flat GraphQL
    obj(obj(pObj.participantType)?.member)?.member, // double-nested GraphQL
    pObj.member,                                // mixed REST/GraphQL
    // old typed REST key
    pObj['com.linkedin.voyager.messaging.MessagingMember'],
    pObj['com.linkedin.voyager.dash.messaging.MessagingMember'],
  ];

  let memberObj: Record<string, unknown> | undefined;
  for (const c of memberCandidates) {
    memberObj = obj(c);
    if (memberObj) break;
  }

  // If none of the above worked, treat the participant object itself as the
  // member (covers old REST where miniProfile is directly on the participant).
  if (!memberObj) memberObj = pObj;

  // ── 3. Resolve miniProfile (old REST paths) ────────────────────────────────
  // memberObj may have a miniProfile child, or it may BE the miniProfile.
  const miniProfileCandidates: unknown[] = [
    memberObj?.miniProfile,
    // typed REST
    (obj(memberObj?.['com.linkedin.voyager.messaging.MessagingMember']))?.miniProfile,
  ];

  let mini: Record<string, unknown> | undefined;
  for (const c of miniProfileCandidates) {
    mini = obj(c);
    if (mini) break;
  }

  // ── 4. Pull firstName / lastName ──────────────────────────────────────────
  // Sources in priority order: memberObj (flat GraphQL), mini (old REST)
  const firstName =
    str(memberObj?.firstName) ??
    str(mini?.firstName) ??
    str(pObj.firstName);

  const lastName =
    str(memberObj?.lastName) ??
    str(mini?.lastName) ??
    str(pObj.lastName);

  const resolvedName =
    directName ??
    (firstName || lastName ? `${firstName ?? ''} ${lastName ?? ''}`.trim() : undefined) ??
    'LinkedIn User';

  // ── 5. ID / profile URL ───────────────────────────────────────────────────
  const publicIdentifier =
    str(memberObj?.publicIdentifier) ??
    str(mini?.publicIdentifier) ??
    str(pObj.publicIdentifier);

  const entityUrn =
    str(memberObj?.entityUrn) ??
    str(mini?.entityUrn) ??
    str(pObj.entityUrn);

  const id = publicIdentifier ?? entityUrn ?? resolvedName;

  const profileUrl = publicIdentifier
    ? `https://www.linkedin.com/in/${publicIdentifier}`
    : undefined;

  // ── 6. Headline ────────────────────────────────────────────────────────────
  // GraphQL: headline may be an object { text: string }
  const headlineRaw =
    memberObj?.headline ??
    mini?.occupation ??
    pObj.headline;

  const headline =
    str(obj(headlineRaw)?.text) ??
    str(headlineRaw);

  // ── 7. Avatar URL ─────────────────────────────────────────────────────────
  // Try all known avatar shapes, most-specific first.
  const avatarUrl =
    // New dash: participantType.member.profilePicture.displayImageReference.vectorImage
    avatarFromVectorImage(
      obj(obj(memberObj?.profilePicture)?.displayImageReference)?.vectorImage,
    ) ??
    // Variant: profilePictureDisplayImage.artifacts (rootUrl lives on the same obj)
    avatarFromVectorImage(obj(memberObj?.profilePictureDisplayImage)) ??
    // participantType.member.photo object with rootUrl + artifacts
    avatarFromPhotoObj(memberObj?.photo) ??
    // Old REST: miniProfile.picture
    avatarFromPhotoObj(mini?.picture) ??
    // Direct picture on participant
    avatarFromPhotoObj(pObj.picture) ??
    // Catch-all: profilePicture directly (some variants)
    avatarFromPhotoObj(memberObj?.profilePicture);

  return { id, name: resolvedName, headline, avatarUrl, profileUrl };
}

// ─── Message preview extraction ───────────────────────────────────────────────

function extractLastMessage(r: Record<string, unknown>): string {
  // 1. conversation.messages.elements[0].body.text  (newer GraphQL)
  const messagesEl = arr(obj(r.messages)?.elements)[0];
  const msgBodyText = str(obj(obj(messagesEl)?.body)?.text);
  if (msgBodyText) return msgBodyText;

  // 2. conversation.lastMessage.body.text
  const lastMsgText = str(obj(obj(r.lastMessage)?.body)?.text);
  if (lastMsgText) return lastMsgText;

  // 3. conversation.lastActivityMessage (simplified formats)
  const lastActivityMsg = str(r.lastActivityMessage);
  if (lastActivityMsg) return lastActivityMsg;

  // 4. conversation.events.elements[0] or events[0]
  const eventsArr =
    arr(obj(r.events)?.elements).length > 0
      ? arr(obj(r.events)?.elements)
      : arr(r.events);

  const firstEvent = obj(eventsArr[0]);
  if (firstEvent) {
    const ec = obj(firstEvent.eventContent);
    if (ec) {
      // 4a. dash variant
      const dashMsg = obj(ec['com.linkedin.voyager.dash.messaging.MessageEvent']);
      const dashText = str(dashMsg?.body) ?? str(obj(dashMsg?.body)?.text);
      if (dashText) return dashText;

      // 4b. old REST typed key
      const oldMsg = obj(ec['com.linkedin.voyager.messaging.event.MessageEvent']);
      const oldText =
        str(obj(oldMsg?.attributedBody)?.text) ??
        str(oldMsg?.body);
      if (oldText) return oldText;

      // 4c. generic body.text on eventContent
      const ecBodyText = str(obj(ec.body)?.text) ?? str(ec.body);
      if (ecBodyText) return ecBodyText;
    }
  }

  return '';
}

// ─── Read status / unread count ───────────────────────────────────────────────

function extractUnreadCount(r: Record<string, unknown>): number {
  return num(r.unreadCount) ?? 0;
}

function extractReadStatus(r: Record<string, unknown>): boolean {
  // bool read flag
  const readFlag = bool(r.read);
  if (readFlag !== undefined) return readFlag;

  // hasUnseenConversation (true = unread → read = false)
  const unseen = bool(r.hasUnseenConversation);
  if (unseen !== undefined) return !unseen;

  // Infer from unreadCount
  const uc = num(r.unreadCount);
  if (uc !== undefined) return uc === 0;

  return true; // default to read
}

// ─── Timestamp ────────────────────────────────────────────────────────────────

function extractTimestamp(r: Record<string, unknown>): string {
  const ms =
    num(r.lastActivityAt) ??
    num(r.updatedAt) ??
    num(r.lastModifiedAt);
  return new Date(ms ?? Date.now()).toISOString();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function transformConversations(
  raw: unknown[],
  source: 'linkedin' | 'sales_nav',
  ctx: TransformContext = {},
): Conversation[] {
  return raw.map((item) => {
    const r = obj(item) ?? {};

    // Resolve any star-prefixed reference fields on the conversation itself
    for (const k of Object.keys(r)) {
      if (k.startsWith('*')) {
        const v = r[k];
        // single URN
        if (typeof v === 'string') {
          const resolved = resolveUrn(v, ctx);
          if (resolved !== v) r[k.slice(1)] = resolved;
        }
        // array of URNs (e.g. *conversationParticipants: ["urn:...", "urn:..."])
        if (Array.isArray(v)) {
          const resolved = v.map((u) => resolveUrn(u, ctx));
          r[k.slice(1)] = resolved;
        }
      }
    }

    // ── Participants ────────────────────────────────────────────────────────
    const rawParticipants = arr(r.participants ?? r.conversationParticipants);

    // Filter out the current user FIRST (using hostIdentityUrn before extraction)
    const me = ctx.myProfileUrn || '';
    const otherParticipants = me
      ? rawParticipants.filter((p) => {
          const o = obj(p);
          const host = o?.hostIdentityUrn;
          return typeof host === 'string' ? host !== me : true;
        })
      : rawParticipants;

    let participants: Participant[] = [];
    for (const p of (otherParticipants.length > 0 ? otherParticipants : rawParticipants)) {
      const participant = extractParticipant(p, ctx);
      if (participant) participants.push(participant);
    }

    // ── Conversation-level display fields (LinkedIn's new GraphQL puts the
    //    name/avatar/headline directly on the conversation, not on participants) ──
    const convTitle = str(r.title) ?? str(obj(r.title)?.text);
    const convSubtitle = str(r.subtitle) ?? str(obj(r.subtitle)?.text);
    const convImage =
      str(obj(r.image)?.rootUrl) ??
      avatarFromPhotoObj(r.image) ??
      avatarFromVectorImage(obj(r.image));

    const allParticipantsAreStubs =
      participants.length === 0 ||
      participants.every((p) => !p.name || p.name === 'LinkedIn User');

    if (allParticipantsAreStubs && convTitle) {
      // Override with conversation-level data
      participants = [{
        id: str(r.entityUrn) ?? convTitle,
        name: convTitle,
        headline: convSubtitle,
        avatarUrl: convImage,
      }];
    } else if (participants.length > 0 && convImage) {
      // Even with participants, conversation image often more accurate
      for (const p of participants) {
        if (!p.avatarUrl) p.avatarUrl = convImage;
        if (!p.headline) p.headline = convSubtitle;
      }
    }

    if (participants.length === 0) {
      participants.push({
        id: str(r.entityUrn) ?? 'unknown',
        name: convTitle ?? 'LinkedIn User',
        headline: convSubtitle,
        avatarUrl: convImage,
      });
    }

    const lastMessage = extractLastMessage(r);
    const isRead = extractReadStatus(r);

    return {
      id: str(r.entityUrn) ?? str(r.id) ?? `conv-${Date.now()}-${Math.random()}`,
      source,
      participants,
      lastMessage,
      lastMessageAt: extractTimestamp(r),
      lastMessageSenderId: '',
      unreadCount: extractUnreadCount(r),
      status: isRead ? 'read' : 'unread',
      labels: [],
      isStarred: false,
    } satisfies Conversation;
  });
}

export function transformMessages(
  raw: unknown[],
  myProfileId: string,
  ctx: TransformContext = {},
): Message[] {
  return raw
    .map((item) => {
      const r = obj(item) ?? {};

      // LinkedIn returns TWO fields:
      //   `sender` — the canonical sender of the message (authoritative)
      //   `actor`  — the "subject" of the message; for connection-request
      //              intros LinkedIn sets actor=recipient, sender=you
      // So we MUST use `sender` for sender identity. Use actor only as a
      // fallback source of display data (member with firstName/lastName).
      const sender = obj(r.sender) ?? obj(r.from) ?? obj(r.fromUser);
      const actor = obj(r.actor);

      const hostUrn =
        str(obj(sender)?.hostIdentityUrn) ??
        str(obj(actor)?.hostIdentityUrn) ??
        str(r['*sender']) ??
        str(r['*from']) ??
        '';

      // For display data (name, avatar): try sender's member first, then
      // actor's member, then resolve hostUrn via entities map.
      const memberFromSender = obj(obj(sender)?.participantType)?.member;
      const memberFromActor = obj(obj(actor)?.participantType)?.member;
      const resolvedFromUrn = hostUrn ? obj(resolveUrn(hostUrn, ctx)) : undefined;
      // IMPORTANT: only use actor.member as a fallback if actor and sender
      // agree (same hostIdentityUrn). Otherwise actor's member belongs to a
      // different person (the recipient in invitation cases).
      const actorMatchesSender =
        sender && actor &&
        str(obj(sender)?.hostIdentityUrn) === str(obj(actor)?.hostIdentityUrn);
      const member: Record<string, unknown> | undefined =
        obj(memberFromSender) ??
        (actorMatchesSender ? obj(memberFromActor) : undefined) ??
        resolvedFromUrn;

      const directBody = str(obj(r.body)?.text) ?? str(r.body);
      if (directBody !== undefined) {
        const senderId = hostUrn;

        // isFromMe — substring match because senderId can be either a raw
        // fsd_profile URN OR a wrapping msg_messagingParticipant URN that
        // embeds the fsd_profile.
        const isFromMe = !!myProfileId && (
          senderId === myProfileId ||
          senderId.includes(myProfileId) ||
          (typeof myProfileId === 'string' && myProfileId.includes(senderId))
        );

        const firstName = str(member?.firstName) ?? '';
        const lastName = str(member?.lastName) ?? '';
        const senderName =
          (firstName || lastName ? `${firstName} ${lastName}`.trim() : undefined) ??
          'LinkedIn User';

        const sentAt =
          num(r.deliveredAt) ??
          num(r.createdAt) ??
          num(r.sentAt) ??
          Date.now();

        return {
          id: str(r.entityUrn) ?? `msg-${Date.now()}-${Math.random()}`,
          conversationId: str(r.conversationUrn) ?? '',
          senderId,
          senderName,
          body: directBody,
          sentAt: new Date(sentAt).toISOString(),
          isFromMe,
        } satisfies Message;
      }

      // ── Old REST shape: eventContent['com.linkedin.voyager.messaging.event.MessageEvent'] ──
      const eventContent = obj(r.eventContent);
      const msgEvent = obj(
        eventContent?.['com.linkedin.voyager.messaging.event.MessageEvent'],
      );
      if (!msgEvent) return null;

      const from = obj(r.from);
      const fromMember = from ? obj(Object.values(from)[0]) : undefined;
      const fromMiniProfile = obj(fromMember?.miniProfile);
      const senderId =
        str(fromMiniProfile?.publicIdentifier ?? fromMiniProfile?.entityUrn) ?? '';

      const body =
        str(obj(msgEvent.attributedBody)?.text) ?? str(msgEvent.body) ?? '';

      const firstName = str(fromMiniProfile?.firstName) ?? '';
      const lastName = str(fromMiniProfile?.lastName) ?? '';
      const senderName =
        firstName || lastName ? `${firstName} ${lastName}`.trim() : 'LinkedIn User';

      return {
        id: str(r.entityUrn) ?? `msg-${Date.now()}`,
        conversationId: '',
        senderId,
        senderName,
        body,
        sentAt: new Date(num(r.createdAt) ?? Date.now()).toISOString(),
        isFromMe: !!myProfileId && senderId === myProfileId,
      } satisfies Message;
    })
    .filter(Boolean) as Message[];
}
