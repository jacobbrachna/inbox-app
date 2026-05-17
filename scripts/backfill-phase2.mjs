// Phase 2 backfill — runs once on the existing dev.db to populate:
//   1. ContactSnapshot — one row per Contact at their current state (so
//      future enrichment changes can be diffed against a baseline)
//   2. Message outcome fields — for every outbound message, scan the next
//      14 days of the same conversation for inbound replies and set
//      gotReply / replyAt / daysToReply
//
// Idempotent — safe to re-run. Wipes existing ContactSnapshot + Message
// outcome data before recomputing.

import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const dbUrl = (process.env.DATABASE_URL ?? 'file:./dev.db').replace(/^file:/, '');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });

const DAY_MS = 24 * 60 * 60 * 1000;
const REPLY_WINDOW_DAYS = 14;

const started = Date.now();
console.log('→ Phase 2 backfill starting');

// ── 1. ContactSnapshot ─────────────────────────────────────────────────
const snapBefore = await prisma.contactSnapshot.count();
if (snapBefore > 0) {
  console.log(`  wiping ${snapBefore} existing ContactSnapshot rows`);
  await prisma.contactSnapshot.deleteMany({});
}

const contacts = await prisma.contact.findMany({
  select: {
    id: true,
    company: true,
    companyDomain: true,
    role: true,
    headline: true,
    source: true,
    lastSeenAt: true,
  },
});
console.log(`  loaded ${contacts.length} contacts`);

// Bulk insert in chunks
const CHUNK = 500;
let snapInserted = 0;
for (let i = 0; i < contacts.length; i += CHUNK) {
  const slice = contacts.slice(i, i + CHUNK);
  await prisma.contactSnapshot.createMany({
    data: slice.map((c) => ({
      contactId: c.id,
      company: c.company,
      companyDomain: c.companyDomain,
      role: c.role,
      headline: c.headline,
      source: c.source,
      capturedAt: c.lastSeenAt,
    })),
  });
  snapInserted += slice.length;
}
console.log(`✓ ContactSnapshot baseline written (${snapInserted} rows)`);

// ── 2. Message outcomes ────────────────────────────────────────────────
// Reset outbound message outcome fields, then replay.
console.log('  resetting outbound outcome fields…');
// Prisma's updateMany doesn't support unsetting datetimes to null inline well;
// use raw SQL via executeRaw for efficiency.
await prisma.$executeRawUnsafe(`UPDATE "Message" SET "gotReply" = false, "replyAt" = NULL, "daysToReply" = NULL WHERE "isFromMe" = true;`);

// Page through messages grouped by conversation so we can scan forward.
const convIds = await prisma.conversation.findMany({
  select: { id: true },
});
console.log(`  scanning ${convIds.length} conversations…`);

let processed = 0;
let outbound = 0;
let withReply = 0;
const PAGE = 100;
for (let i = 0; i < convIds.length; i += PAGE) {
  const slice = convIds.slice(i, i + PAGE).map((c) => c.id);
  const msgs = await prisma.message.findMany({
    where: { conversationId: { in: slice } },
    orderBy: [{ conversationId: 'asc' }, { sentAt: 'asc' }],
    select: { id: true, conversationId: true, sentAt: true, isFromMe: true },
  });

  // Group by conv id
  const byConv = new Map();
  for (const m of msgs) {
    if (!byConv.has(m.conversationId)) byConv.set(m.conversationId, []);
    byConv.get(m.conversationId).push(m);
  }

  for (const [, list] of byConv) {
    for (let j = 0; j < list.length; j++) {
      const m = list[j];
      if (!m.isFromMe) continue;
      outbound++;
      const tMs = m.sentAt.getTime();
      const deadline = tMs + REPLY_WINDOW_DAYS * DAY_MS;
      // Scan forward for first inbound within deadline
      for (let k = j + 1; k < list.length; k++) {
        const nxt = list[k];
        if (nxt.sentAt.getTime() > deadline) break;
        if (!nxt.isFromMe) {
          const days = Math.max(0, Math.round((nxt.sentAt.getTime() - tMs) / DAY_MS));
          await prisma.message.update({
            where: { id: m.id },
            data: {
              gotReply: true,
              replyAt: nxt.sentAt,
              daysToReply: days,
            },
          });
          withReply++;
          break;
        }
      }
    }
  }
  processed += slice.length;
  if (processed % 500 === 0 || processed === convIds.length) {
    console.log(`  …${processed}/${convIds.length} conversations`);
  }
}

const replyRate = outbound > 0 ? Math.round((withReply / outbound) * 100) : 0;
console.log(`✓ Outcomes: ${outbound} outbound messages scanned, ${withReply} got a reply (${replyRate}%)`);

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`✓ Phase 2 backfill done in ${elapsed}s`);
await prisma.$disconnect();
