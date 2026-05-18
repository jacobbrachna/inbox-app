// Clears the `headline` field on every Sales Navigator conversation's
// participants. Used as a one-shot reset after we discovered some rows
// had message bodies written into the headline slot (the chat-bubble
// header showing "👍Thanks! Have a nice day!" instead of a job title).
//
// After running this, hit Diagnostics → Full LinkedIn re-sync or open
// Sales Navigator and click the floating sync button. The
// /api/import/sales-nav-profile pipeline will repopulate real headlines
// (job title at company) the next time the profile endpoint is hit.
//
// Usage:  node scripts/clear-sn-headlines.mjs

import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const dbUrl = (process.env.DATABASE_URL ?? 'file:./dev.db').replace(/^file:/, '');
const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: dbUrl }),
});

async function main() {
  const convs = await prisma.conversation.findMany({
    where: { source: 'sales_nav' },
    select: { id: true, participants: true },
  });

  let touched = 0;
  let participantsCleared = 0;

  for (const c of convs) {
    let parts;
    try {
      parts = JSON.parse(c.participants);
    } catch {
      continue;
    }
    if (!Array.isArray(parts)) continue;

    let changed = false;
    const next = parts.map((p) => {
      if (!p || typeof p !== 'object') return p;
      if (typeof p.headline !== 'string' || p.headline === '') return p;
      changed = true;
      participantsCleared++;
      const { headline, ...rest } = p;
      return rest;
    });

    if (changed) {
      await prisma.conversation.update({
        where: { id: c.id },
        data: { participants: JSON.stringify(next) },
      });
      touched++;
    }
  }

  console.log(`Cleared ${participantsCleared} participant headlines across ${touched} SN conversations.`);
  console.log(`Sales Nav conversations scanned: ${convs.length}`);
  console.log();
  console.log('Next step: open Sales Navigator → click the floating sync button,');
  console.log('or hit Diagnostics → Full LinkedIn re-sync. Real headlines will be');
  console.log('refilled by the /api/import/sales-nav-profile endpoint.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
