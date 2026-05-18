// One-shot cleanup: remove "recentPosts" entries whose body text matches
// known LinkedIn error-page copy. These got captured when the profile-
// capture tab loaded a logged-out / rate-limited / not-found page and the
// scraper saved the error message as a "post". Affects both
// Conversation.enrichment.recentPosts and Contact.recentPosts.
//
// After this runs, re-enrich those contacts (Contact details → Refresh
// profile) so we pull real posts.
//
// Usage:  node scripts/clear-error-page-posts.mjs

import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const dbUrl = (process.env.DATABASE_URL ?? 'file:./dev.db').replace(/^file:/, '');
const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: dbUrl }),
});

// Phrases that should never appear as the body of a real LinkedIn post —
// they're the standard error / interstitial / sign-in page copy.
const ERROR_PHRASES = [
  'Check your connection',
  "This page isn't available",
  'This page isn’t available',
  'Page not found',
  "We can't seem to find",
  'We can’t seem to find',
  'Sign in to LinkedIn',
  'something went wrong',
];

function looksLikeError(text) {
  if (typeof text !== 'string') return false;
  return ERROR_PHRASES.some((p) => text.includes(p));
}

function filterPosts(posts) {
  if (!Array.isArray(posts)) return { posts, changed: false };
  const next = posts.filter((p) => !looksLikeError(p?.text));
  return { posts: next, changed: next.length !== posts.length };
}

async function cleanConversations() {
  const rows = await prisma.conversation.findMany({
    where: { enrichment: { contains: 'Check your connection' } },
    select: { id: true, enrichment: true },
  });
  let touched = 0;
  for (const r of rows) {
    if (!r.enrichment) continue;
    let parsed;
    try { parsed = JSON.parse(r.enrichment); } catch { continue; }
    const { posts, changed } = filterPosts(parsed.recentPosts);
    if (!changed) continue;
    parsed.recentPosts = posts.length > 0 ? posts : null;
    await prisma.conversation.update({
      where: { id: r.id },
      data: { enrichment: JSON.stringify(parsed) },
    });
    touched++;
  }
  return touched;
}

async function cleanContacts() {
  const rows = await prisma.contact.findMany({
    where: { recentPosts: { contains: 'Check your connection' } },
    select: { id: true, recentPosts: true },
  });
  let touched = 0;
  for (const r of rows) {
    if (!r.recentPosts) continue;
    let parsed;
    try { parsed = JSON.parse(r.recentPosts); } catch { continue; }
    const { posts, changed } = filterPosts(parsed);
    if (!changed) continue;
    await prisma.contact.update({
      where: { id: r.id },
      data: { recentPosts: posts.length > 0 ? JSON.stringify(posts) : null },
    });
    touched++;
  }
  return touched;
}

async function main() {
  const convsCleaned = await cleanConversations();
  const contactsCleaned = await cleanContacts();
  console.log(`Cleaned ${convsCleaned} conversations and ${contactsCleaned} contacts.`);
  console.log('Re-enrich each contact via the Refresh profile button to pull real posts.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
