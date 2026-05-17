// One-shot cleanup: remove deprecated regex labels (auto-interested,
// auto-meeting-set) that have been superseded by AI-managed equivalents.
//
// Strips them from Conversation.labels JSON arrays and deletes the Label rows.
// Idempotent.

import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const dbUrl = (process.env.DATABASE_URL ?? 'file:./dev.db').replace(/^file:/, '');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });

const DEPRECATED = new Set([
  'auto-interested',
  'auto-meeting-set',
]);

let convsTouched = 0;
const convs = await prisma.conversation.findMany({
  where: { labels: { contains: 'auto-' } },
  select: { id: true, labels: true },
});
for (const c of convs) {
  let arr;
  try { arr = JSON.parse(c.labels); } catch { continue; }
  if (!Array.isArray(arr)) continue;
  const filtered = arr.filter((id) => !DEPRECATED.has(id));
  if (filtered.length !== arr.length) {
    await prisma.conversation.update({
      where: { id: c.id },
      data: { labels: JSON.stringify(filtered) },
    });
    convsTouched++;
  }
}

const deleted = await prisma.label.deleteMany({
  where: { id: { in: [...DEPRECATED] } },
});

console.log(`✓ Stripped deprecated labels from ${convsTouched} conversations`);
console.log(`✓ Deleted ${deleted.count} Label rows`);
await prisma.$disconnect();
