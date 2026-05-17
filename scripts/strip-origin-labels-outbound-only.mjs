// One-shot: strip origin-group labels (Recruiter / Sales pitch / Mutual intro)
// from conversations where the user is the only sender (zero inbound messages).
// The classify endpoint now enforces this going forward; this fixes the
// historical state from prior runs.

import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const dbUrl = (process.env.DATABASE_URL ?? 'file:./dev.db').replace(/^file:/, '');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });

const originLabels = await prisma.label.findMany({
  where: { exclusiveGroup: 'origin' },
  select: { id: true },
});
const originIds = new Set(originLabels.map((l) => l.id));
console.log(`  Found ${originIds.size} origin-group labels: ${[...originIds].join(', ')}`);

// Find convs with origin labels and zero inbound messages.
const candidates = await prisma.conversation.findMany({
  where: {
    OR: [...originIds].map((id) => ({ labels: { contains: `"${id}"` } })),
  },
  select: {
    id: true,
    labels: true,
    _count: { select: { messages: { where: { isFromMe: false } } } },
  },
});
console.log(`  ${candidates.length} convs have origin labels`);

let stripped = 0;
for (const c of candidates) {
  if (c._count.messages > 0) continue; // has inbound — leave alone
  let arr;
  try { arr = JSON.parse(c.labels); } catch { continue; }
  if (!Array.isArray(arr)) continue;
  const filtered = arr.filter((id) => !originIds.has(id));
  if (filtered.length !== arr.length) {
    await prisma.conversation.update({
      where: { id: c.id },
      data: { labels: JSON.stringify(filtered) },
    });
    stripped++;
  }
}

console.log(`✓ Stripped origin labels from ${stripped} outbound-only conversations`);
await prisma.$disconnect();
