// One-time backfill: walk existing Conversations + Messages and populate
// the Contact and ConversationContact tables.
//
// Idempotent — safe to re-run. Identity resolution priority:
//   linkedinUrn > profileSlug > normalized(name)
// Existing Contact rows are upserted; merge uses source-priority precedence:
//   linkedin-export > dom-capture > ai-headline > harvest > unknown
//
// Usage:  node scripts/backfill-contacts.mjs

import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

// Prisma 7 requires a driver adapter — matches src/lib/db.ts.
const dbUrl = (process.env.DATABASE_URL ?? 'file:./dev.db').replace(/^file:/, '');
const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: dbUrl }),
});

// ── Identity helpers ──────────────────────────────────────────────────────
const SOURCE_PRIORITY = {
  'linkedin-export': 4,
  'dom-capture': 3,
  'ai-headline': 2,
  'harvest': 1,
};

function normalizeName(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// LinkedIn returns these placeholder names when the real user info isn't
// available (deleted accounts, restricted visibility, etc). They are NOT
// real names — treating two "LinkedIn User" contacts as the same person
// would merge dozens of unrelated people into one record.
const SENTINEL_NAMES = new Set([
  'linkedin user',
  'linkedin member',
]);

function isSentinelName(s) {
  return SENTINEL_NAMES.has(normalizeName(s));
}

// Extract the canonical profile URN (urn:li:fsd_profile:ACoAA...) from any
// wrapped LinkedIn URN format we've seen: messagingParticipant wrappers,
// bare profile URNs, etc.
function extractProfileUrn(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/urn:li:fsd_profile:[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

function extractProfileSlug(profileUrl) {
  if (typeof profileUrl !== 'string') return null;
  try {
    const u = new URL(profileUrl);
    if (!u.pathname.startsWith('/in/')) return null;
    const slug = u.pathname.replace(/^\/in\/|\/+$/g, '').split('/')[0];
    return slug || null;
  } catch {
    return null;
  }
}

// Parse a conversation's enrichment blob safely.
function parseEnrichment(s) {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// Merge B into A using source-priority precedence. A wins on tie.
function mergeContactData(a, b) {
  const aP = SOURCE_PRIORITY[a.source] ?? 0;
  const bP = SOURCE_PRIORITY[b.source] ?? 0;
  const bWins = bP > aP;
  const out = { ...a };
  // Identity keys: always fill if missing
  for (const k of ['linkedinUrn', 'profileSlug', 'profileUrl', 'avatarUrl']) {
    if (!out[k] && b[k]) out[k] = b[k];
  }
  // Display + position: b wins only if b's source rank > a's
  for (const k of ['name', 'headline', 'company', 'companyDomain', 'role', 'location', 'industry', 'tenure']) {
    if (b[k] && (bWins || !out[k])) out[k] = b[k];
  }
  // Source: keep the higher
  if (bP > aP) out.source = b.source;
  // firstSeenAt: earlier wins
  if (b.firstSeenAt && (!out.firstSeenAt || b.firstSeenAt < out.firstSeenAt)) {
    out.firstSeenAt = b.firstSeenAt;
  }
  // lastSeenAt: later wins
  if (b.lastSeenAt && (!out.lastSeenAt || b.lastSeenAt > out.lastSeenAt)) {
    out.lastSeenAt = b.lastSeenAt;
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const started = Date.now();
  console.log('→ Backfill starting');

  // Idempotency: wipe Contact + ConversationContact so re-runs produce
  // identical state. ConversationContact has cascade-delete from Contact,
  // but we delete both explicitly for clarity.
  const before = {
    contacts: await prisma.contact.count(),
    cc: await prisma.conversationContact.count(),
  };
  if (before.contacts || before.cc) {
    console.log(`  clearing ${before.cc} ConversationContact + ${before.contacts} Contact rows`);
    await prisma.conversationContact.deleteMany({});
    await prisma.contact.deleteMany({});
  }

  const appState = await prisma.appState.findFirst();
  const selfUrn = appState?.myProfileUrn ?? null;
  console.log(`  self URN: ${selfUrn ?? '(unknown — group thread filtering disabled)'}`);

  // 1. Walk Conversations, extract participants, build a contact map keyed
  //    by best-available identity. We track per-conversation which contact
  //    keys appear, so we can write ConversationContact rows afterwards.
  const convs = await prisma.conversation.findMany({
    select: {
      id: true,
      participants: true,
      enrichment: true,
      createdAt: true,
      lastMessageAt: true,
    },
  });
  console.log(`  loaded ${convs.length} conversations`);

  // Two-level keying: try URN first, fall back to slug, fall back to name.
  // contactByUrn: Map<urn, contactData>
  // contactBySlug: Map<slug, contactData>  (only when no URN known)
  // contactByName: Map<normName, contactData>  (only when neither known)
  const byUrn = new Map();
  const bySlug = new Map();
  const byName = new Map();

  // Track per-conversation the resolved contact keys (after backfill we'll
  // re-resolve each key → contactData → final cuid).
  const convToContactKeys = new Map(); // convId → Set<'urn:..|slug:..|name:..'>

  // Anonymous (sentinel-named, no URN/slug) contacts — each occurrence is a
  // different real person; keyed uniquely so they never collapse.
  const byAnon = new Map(); // anonKey → contactData
  let anonCounter = 0;
  function resolveOrInsert(c) {
    if (!c.linkedinUrn && !c.profileSlug && isSentinelName(c.name)) {
      const key = `anon:${++anonCounter}`;
      byAnon.set(key, c);
      return key;
    }
    // Returns the stable key string we'll use to look this contact up later.
    const tryKeys = [];
    if (c.linkedinUrn) tryKeys.push(`urn:${c.linkedinUrn}`);
    if (c.profileSlug) tryKeys.push(`slug:${c.profileSlug}`);
    if (c.name) tryKeys.push(`name:${normalizeName(c.name)}`);

    // Look for an existing record under any of these keys
    let existingKey = null;
    let existing = null;
    for (const k of tryKeys) {
      if (k.startsWith('urn:') && byUrn.has(c.linkedinUrn)) {
        existingKey = k; existing = byUrn.get(c.linkedinUrn); break;
      }
      if (k.startsWith('slug:') && bySlug.has(c.profileSlug)) {
        existingKey = k; existing = bySlug.get(c.profileSlug); break;
      }
      if (k.startsWith('name:') && byName.has(normalizeName(c.name))) {
        existingKey = k; existing = byName.get(normalizeName(c.name)); break;
      }
    }

    if (existing) {
      const merged = mergeContactData(existing, c);
      // Re-index under any newly-discovered identity keys
      if (merged.linkedinUrn) byUrn.set(merged.linkedinUrn, merged);
      if (merged.profileSlug) bySlug.set(merged.profileSlug, merged);
      if (merged.name) byName.set(normalizeName(merged.name), merged);
      // Best key in priority order
      if (merged.linkedinUrn) return `urn:${merged.linkedinUrn}`;
      if (merged.profileSlug) return `slug:${merged.profileSlug}`;
      return `name:${normalizeName(merged.name)}`;
    } else {
      // Fresh contact
      if (c.linkedinUrn) byUrn.set(c.linkedinUrn, c);
      if (c.profileSlug) bySlug.set(c.profileSlug, c);
      if (c.name) byName.set(normalizeName(c.name), c);
      if (c.linkedinUrn) return `urn:${c.linkedinUrn}`;
      if (c.profileSlug) return `slug:${c.profileSlug}`;
      return `name:${normalizeName(c.name)}`;
    }
  }

  for (const conv of convs) {
    let participants;
    try {
      participants = JSON.parse(conv.participants || '[]');
    } catch {
      participants = [];
    }
    const enrichment = parseEnrichment(conv.enrichment);
    const enrichmentSource = typeof enrichment.source === 'string' ? enrichment.source : 'harvest';

    const keys = new Set();
    for (const p of participants) {
      const urn = extractProfileUrn(p.id);
      // Skip self on group threads
      if (selfUrn && urn === selfUrn) continue;
      if (!p.name) continue;

      const slug = extractProfileSlug(p.profileUrl);
      // Convention: each conversation's enrichment is about the OTHER party,
      // so on 1:1 threads we apply it to this participant. For group threads
      // we still apply it — best effort; user can correct later.
      const c = {
        linkedinUrn: urn || null,
        profileSlug: slug || null,
        profileUrl: p.profileUrl || null,
        name: p.name,
        headline: p.headline || enrichment.headline || null,
        avatarUrl: p.avatarUrl || null,
        company: p.company || enrichment.company || null,
        role: enrichment.role || null,
        location: enrichment.location || null,
        industry: enrichment.industry || null,
        tenure: enrichment.tenure || null,
        source: enrichmentSource,
        firstSeenAt: conv.createdAt,
        lastSeenAt: conv.lastMessageAt,
      };
      const key = resolveOrInsert(c);
      keys.add(key);
    }
    convToContactKeys.set(conv.id, keys);
  }

  console.log(`  resolved ${byUrn.size} contacts by URN, ${bySlug.size} by slug, ${byName.size} by name`);

  // 2. De-dupe across the three maps: a single person may have ended up in
  //    multiple maps as we discovered identity keys progressively. Collapse
  //    by walking byUrn first (highest confidence), then bySlug for any not
  //    already covered, then byName.
  const finalContacts = new Map(); // key → contactData
  for (const [urn, c] of byUrn) finalContacts.set(`urn:${urn}`, c);
  for (const [slug, c] of bySlug) {
    if (c.linkedinUrn && finalContacts.has(`urn:${c.linkedinUrn}`)) continue;
    finalContacts.set(`slug:${slug}`, c);
  }
  for (const [name, c] of byName) {
    if (c.linkedinUrn && finalContacts.has(`urn:${c.linkedinUrn}`)) continue;
    if (c.profileSlug && finalContacts.has(`slug:${c.profileSlug}`)) continue;
    finalContacts.set(`name:${name}`, c);
  }
  // Anonymous contacts are always unique — each gets its own row.
  for (const [key, c] of byAnon) finalContacts.set(key, c);

  console.log(`  final unique contacts: ${finalContacts.size} (incl. ${byAnon.size} anonymous)`);

  // 3. Compute activity rollups from Messages. Build URN-keyed maps for
  //    inbound (matches Message.senderId's inner profile URN) and a
  //    per-conversation map for outbound (applies to all non-self contacts
  //    on the conversation).
  console.log('  computing activity rollups…');

  // Map URN → { count, lastAt }
  const inboundByUrn = new Map();
  // Map convId → { count, lastAt }  (outbound messages aggregated per conv)
  const outboundByConv = new Map();

  // Stream messages in batches to keep memory bounded
  const PAGE = 5000;
  let cursor = null;
  let scanned = 0;
  while (true) {
    const batch = await prisma.message.findMany({
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, conversationId: true, senderId: true, sentAt: true, isFromMe: true },
    });
    if (!batch.length) break;
    for (const m of batch) {
      if (m.isFromMe) {
        const cur = outboundByConv.get(m.conversationId) || { count: 0, lastAt: null };
        cur.count++;
        if (!cur.lastAt || m.sentAt > cur.lastAt) cur.lastAt = m.sentAt;
        outboundByConv.set(m.conversationId, cur);
      } else {
        const urn = extractProfileUrn(m.senderId);
        if (!urn) continue;
        const cur = inboundByUrn.get(urn) || { count: 0, lastAt: null };
        cur.count++;
        if (!cur.lastAt || m.sentAt > cur.lastAt) cur.lastAt = m.sentAt;
        inboundByUrn.set(urn, cur);
      }
    }
    scanned += batch.length;
    cursor = batch[batch.length - 1].id;
    if (batch.length < PAGE) break;
  }
  console.log(`  scanned ${scanned} messages`);

  // 4. Assign cuids and write Contacts. We do this in batches via createMany
  //    for speed. We need to track key → newCuid so we can wire join rows.
  const keyToCuid = new Map();
  // Pre-generate cuids using Prisma's default by inserting and getting back the id.
  // createMany doesn't return ids in SQLite — so we batch-insert via raw
  // transactions and read the inserted ids after.
  console.log('  inserting Contact rows…');

  const contactsToInsert = [];
  for (const [key, c] of finalContacts) {
    const urn = c.linkedinUrn || null;
    const inbound = urn ? (inboundByUrn.get(urn) || { count: 0, lastAt: null }) : { count: 0, lastAt: null };
    contactsToInsert.push({
      key,
      data: {
        linkedinUrn: c.linkedinUrn || null,
        profileSlug: c.profileSlug || null,
        profileUrl: c.profileUrl || null,
        name: c.name,
        headline: c.headline || null,
        avatarUrl: c.avatarUrl || null,
        company: c.company || null,
        role: c.role || null,
        location: c.location || null,
        industry: c.industry || null,
        tenure: c.tenure || null,
        source: c.source || null,
        firstSeenAt: c.firstSeenAt || new Date(),
        lastSeenAt: c.lastSeenAt || new Date(),
        lastInboundAt: inbound.lastAt || null,
        inboundCount: inbound.count,
      },
    });
  }

  // Insert with prisma.contact.create one-by-one within a transaction so we
  // capture cuids. 38MB DB, ~few thousand contacts — fine for one-shot.
  await prisma.$transaction(async (tx) => {
    for (const { key, data } of contactsToInsert) {
      const created = await tx.contact.create({ data });
      keyToCuid.set(key, created.id);
    }
  }, { timeout: 120000 });
  console.log(`  inserted ${contactsToInsert.length} Contact rows`);

  // 5. Build ConversationContact rows + compute outbound rollups per contact
  //    (a contact's outbound = sum across all their conversations).
  const ccRows = [];
  // contactId → { lastOutboundAt, outboundCount, conversationCount }
  const outboundByContact = new Map();
  for (const [convId, keys] of convToContactKeys) {
    const out = outboundByConv.get(convId) || { count: 0, lastAt: null };
    for (const key of keys) {
      // Re-resolve the key in case it was collapsed into a higher-priority one
      let resolvedKey = key;
      if (!keyToCuid.has(resolvedKey)) {
        // Try to find via the URN/slug/name in the contactData
        // (This happens when a name-keyed entry got merged into a URN-keyed one)
        // Look it up in finalContacts; if missing, look in byUrn/bySlug/byName
        // and find the contactData, then build a higher-priority key.
        const fallback = byName.get(key.replace(/^name:/, ''));
        if (fallback) {
          if (fallback.linkedinUrn) resolvedKey = `urn:${fallback.linkedinUrn}`;
          else if (fallback.profileSlug) resolvedKey = `slug:${fallback.profileSlug}`;
        }
      }
      const contactId = keyToCuid.get(resolvedKey);
      if (!contactId) {
        console.warn(`  ! could not resolve key ${key} → contactId; skipping`);
        continue;
      }
      ccRows.push({ conversationId: convId, contactId });
      const cur = outboundByContact.get(contactId) || { lastOutboundAt: null, outboundCount: 0, conversationCount: 0 };
      cur.conversationCount++;
      cur.outboundCount += out.count;
      if (out.lastAt && (!cur.lastOutboundAt || out.lastAt > cur.lastOutboundAt)) {
        cur.lastOutboundAt = out.lastAt;
      }
      outboundByContact.set(contactId, cur);
    }
  }

  console.log(`  inserting ${ccRows.length} ConversationContact rows…`);
  // De-dupe (in case the same contact appears twice on a group thread by mistake)
  const ccSeen = new Set();
  const ccDedup = ccRows.filter((r) => {
    const k = `${r.conversationId}|${r.contactId}`;
    if (ccSeen.has(k)) return false;
    ccSeen.add(k);
    return true;
  });
  // createMany with skipDuplicates
  // SQLite via Prisma 7 doesn't support skipDuplicates; we already de-duped above.
  // Insert in chunks to keep query size reasonable.
  const CHUNK = 500;
  for (let i = 0; i < ccDedup.length; i += CHUNK) {
    await prisma.conversationContact.createMany({ data: ccDedup.slice(i, i + CHUNK) });
  }

  // 6. Patch outbound rollups onto contacts
  console.log('  patching outbound rollups…');
  await prisma.$transaction(async (tx) => {
    for (const [contactId, r] of outboundByContact) {
      await tx.contact.update({
        where: { id: contactId },
        data: {
          lastOutboundAt: r.lastOutboundAt,
          outboundCount: r.outboundCount,
          conversationCount: r.conversationCount,
        },
      });
    }
  }, { timeout: 120000 });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`✓ Backfill done in ${elapsed}s`);

  // Summary
  const counts = {
    contacts: await prisma.contact.count(),
    cc: await prisma.conversationContact.count(),
    convs: await prisma.conversation.count(),
    msgs: await prisma.message.count(),
  };
  console.log(`  Contact=${counts.contacts}  ConversationContact=${counts.cc}  Conversation=${counts.convs}  Message=${counts.msgs}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
