// One-time backfill: pull connectedOn from existing Conversation.enrichment
// blobs and write it onto the matching Contact row (via ConversationContact).
//
// Safe to re-run: only updates Contacts where connectedOn IS NULL, and never
// downgrades an existing date.

import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const dbUrl = (process.env.DATABASE_URL ?? 'file:./dev.db').replace(/^file:/, '');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });

function parseLinkedInDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) {
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  }
  const [, day, mon, year] = m;
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const mi = months[mon.toLowerCase().slice(0, 3)];
  if (mi === undefined) return null;
  const d = new Date(Date.UTC(Number(year), mi, Number(day)));
  return isNaN(d.getTime()) ? null : d;
}

const started = Date.now();
console.log('→ Backfill connectedOn starting');

const convs = await prisma.conversation.findMany({
  where: { enrichment: { contains: 'connectedOn' } },
  select: {
    id: true,
    enrichment: true,
    contacts: { select: { contactId: true } },
  },
});
console.log(`  ${convs.length} conversations with connectedOn`);

let updated = 0;
let parseFailed = 0;
const seen = new Set();
for (const conv of convs) {
  let parsed;
  try { parsed = JSON.parse(conv.enrichment); } catch { continue; }
  const raw = parsed?.connectedOn;
  if (!raw) continue;
  const date = parseLinkedInDate(raw);
  if (!date) { parseFailed++; continue; }
  for (const cc of conv.contacts) {
    if (seen.has(cc.contactId)) continue; // already handled
    seen.add(cc.contactId);
    const existing = await prisma.contact.findUnique({
      where: { id: cc.contactId },
      select: { connectedOn: true },
    });
    if (!existing) continue;
    // Prefer the earlier date when one already exists
    if (existing.connectedOn && existing.connectedOn <= date) continue;
    await prisma.contact.update({
      where: { id: cc.contactId },
      data: { connectedOn: date },
    });
    updated++;
  }
}

console.log(`✓ Updated ${updated} contacts (${parseFailed} parse failures) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
await prisma.$disconnect();
