// Run-once verification suite. Probes the prod server + DB + extension
// source files so you don't have to click through every feature by hand.
//
// Usage:  node scripts/healthcheck.mjs
//
// Prints a checklist with ✓ / ✗ per item. Exit code 0 if everything
// passes, 1 if anything failed (so it's safe to wire into CI later).

import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.INBOXPRO_URL || 'http://localhost:3030';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';
const NC    = '\x1b[0m';

const results = [];
function pass(name, detail = '') {
  results.push({ ok: true, name, detail });
  console.log(`${GREEN}✓${NC} ${name}${detail ? `  ${DIM}${detail}${NC}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ ok: false, name, detail });
  console.log(`${RED}✗${NC} ${name}${detail ? `  ${DIM}${detail}${NC}` : ''}`);
}
function section(s) {
  console.log(`\n${BOLD}${s}${NC}`);
}

// ─── Server reachability ─────────────────────────────────────────────────
async function fetchJson(p, init) {
  const r = await fetch(BASE + p, init);
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, ok: r.ok, body };
}

async function checkServer() {
  section('Server');
  try {
    const r = await fetchJson('/api/state');
    if (r.ok) pass('GET /api/state', `${r.status}`);
    else fail('GET /api/state', `${r.status}`);
  } catch (e) {
    fail('Server unreachable', `${BASE} — start it with npm run restart`);
  }
}

async function checkRoutes() {
  section('API routes');
  const ROUTES = [
    '/api/conversations',
    '/api/labels',
    '/api/snippets',
    '/api/notifications',
    '/api/tasks',
    '/api/patterns',
    '/api/parser-health',
    '/api/queue',
    '/api/contacts',
  ];
  for (const p of ROUTES) {
    try {
      const r = await fetchJson(p);
      if (r.ok) pass(`GET ${p}`, `${r.status}`);
      else fail(`GET ${p}`, `${r.status}`);
    } catch {
      fail(`GET ${p}`, 'fetch threw');
    }
  }
}

async function checkAiKey() {
  section('Anthropic key');
  try {
    const r = await fetchJson('/api/ai/key/verify', { method: 'POST' });
    if (r.ok && r.body?.ok) pass('POST /api/ai/key/verify', 'live 1-token Haiku call succeeded');
    else fail('POST /api/ai/key/verify', JSON.stringify(r.body).slice(0, 120));
  } catch (e) {
    fail('POST /api/ai/key/verify', e.message);
  }
}

// ─── DB ──────────────────────────────────────────────────────────────────
const dbUrl = (process.env.DATABASE_URL ?? 'file:./dev.db').replace(/^file:/, '');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });

async function checkDb() {
  section('Database');
  try {
    const counts = {
      conversations: await prisma.conversation.count(),
      messages:      await prisma.message.count(),
      contacts:      await prisma.contact.count(),
      labels:        await prisma.label.count(),
      snippets:      await prisma.snippet.count(),
    };
    const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · ');
    pass('Table counts', summary);
  } catch (e) {
    fail('Table counts', e.message);
  }
}

async function checkCorruption() {
  section('Data quality');

  // SN headlines: count rows whose participant headline is still a message-
  // body-shape (emoji prefix or matches lastMessage). After the cleanup this
  // should be 0 for emoji-prefixed, but >0 is OK if real headlines refilled.
  const sn = await prisma.conversation.findMany({
    where: { source: 'sales_nav' },
    select: { id: true, participants: true, lastMessage: true },
  });
  let suspect = 0;
  for (const c of sn) {
    let parts;
    try { parts = JSON.parse(c.participants); } catch { continue; }
    for (const p of parts) {
      if (typeof p?.headline !== 'string') continue;
      const h = p.headline.trim();
      if (!h) continue;
      // Real LinkedIn headlines often contain decorative emojis (♦ ⚡ 🔹).
      // The only reliable corruption signature is: headline equals the
      // conversation's lastMessage exactly. That can only happen if a
      // sync put the message body into the headline slot.
      const matchesLast = c.lastMessage && h === c.lastMessage;
      if (matchesLast) suspect++;
    }
  }
  if (suspect === 0) pass('SN headlines — no message-shaped values', `scanned ${sn.length} convs`);
  else fail('SN headlines — message-shaped values detected', `${suspect} rows — run scripts/clear-sn-headlines.mjs`);

  // Error-page posts cleared
  const errorPosts = await prisma.conversation.count({
    where: { enrichment: { contains: 'Check your connection' } },
  });
  if (errorPosts === 0) pass('Error-page posts cleared in Conversation.enrichment');
  else fail('Error-page posts still present', `${errorPosts} rows — run scripts/clear-error-page-posts.mjs`);

  const errorPostsContacts = await prisma.contact.count({
    where: { recentPosts: { contains: 'Check your connection' } },
  });
  if (errorPostsContacts === 0) pass('Error-page posts cleared in Contact.recentPosts');
  else fail('Error-page posts in Contact.recentPosts', `${errorPostsContacts} rows`);

  // Drafts: every status='draft' conv has an id with draft: prefix (we
  // refused status flips earlier — verify the invariant still holds).
  const orphanDrafts = await prisma.conversation.findMany({
    where: { status: 'draft' },
    select: { id: true },
  });
  const bad = orphanDrafts.filter((d) => !d.id.startsWith('draft:'));
  if (bad.length === 0) pass('Draft rows — all use draft: prefix', `${orphanDrafts.length} drafts total`);
  else fail('Draft rows with wrong ID prefix', `${bad.length} rows`);
}

// ─── Migrations ──────────────────────────────────────────────────────────
async function checkMigrations() {
  section('Migrations');
  try {
    const dir = path.join(ROOT, 'prisma', 'migrations');
    const folders = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isDirectory());
    const applied = await prisma.$queryRaw`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    const appliedNames = new Set(applied.map((r) => r.migration_name));
    const missing = folders.filter((f) => !appliedNames.has(f));
    if (missing.length === 0) pass('All migrations applied', `${folders.length} total`);
    else fail('Pending migrations', `${missing.length} — run npx prisma migrate deploy: ${missing.join(', ')}`);
  } catch (e) {
    fail('Migration check', e.message);
  }
}

// ─── Extension source ───────────────────────────────────────────────────
function checkExtension() {
  section('Extension source');
  const files = [
    'bridge.js', 'background.js', 'content.js', 'injected.js',
    'profile-capture.js', 'sn-sync-button.js', 'li-sync-button.js',
    'manifest.json',
  ];
  const dir = path.join(ROOT, 'extension');
  let missing = 0;
  for (const f of files) {
    const fp = path.join(dir, f);
    if (!fs.existsSync(fp)) { missing++; fail(`Missing ${f}`); continue; }
  }
  if (missing === 0) pass(`All extension files present`, `${files.length} files`);

  // bridge.js: still injects #inboxpro-bridge-marker?
  const bridge = fs.readFileSync(path.join(dir, 'bridge.js'), 'utf8');
  if (bridge.includes("marker.id = 'inboxpro-bridge-marker'")) pass('bridge.js still injects the marker');
  else fail('bridge.js marker injection missing — UI bridge gate will never flip');

  // manifest.json: bridge.js mapped to localhost?
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const bridgeRoute = manifest.content_scripts?.find((s) => s.js?.includes('bridge.js'));
  if (bridgeRoute?.matches?.some((m) => m.includes('localhost'))) pass('manifest.json — bridge.js wired to localhost');
  else fail('manifest.json — bridge.js NOT wired to localhost');
}

// ─── Recent activity ─────────────────────────────────────────────────────
async function checkRecentActivity() {
  section('Recent sync activity');
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await prisma.message.count({ where: { sentAt: { gte: since } } });
    if (recent > 0) pass('Messages in last 24h', `${recent}`);
    else fail('No messages in last 24h', 'try the floating sync button on LinkedIn');

    const lastSync = await prisma.appState.findUnique({ where: { id: 1 }, select: { lastSyncedAt: true } });
    if (lastSync?.lastSyncedAt) {
      const ago = Math.floor((Date.now() - new Date(lastSync.lastSyncedAt).getTime()) / 60_000);
      pass('Last sync timestamp', `${ago} min ago`);
    } else {
      fail('No lastSyncedAt — never synced');
    }
  } catch (e) {
    fail('Activity check', e.message);
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`${BOLD}InboxPro health check${NC}  ${DIM}${BASE}${NC}\n`);
  await checkServer();
  await checkRoutes();
  await checkAiKey();
  await checkDb();
  await checkCorruption();
  await checkMigrations();
  checkExtension();
  await checkRecentActivity();

  const failures = results.filter((r) => !r.ok);
  console.log();
  if (failures.length === 0) {
    console.log(`${GREEN}${BOLD}All ${results.length} checks passed.${NC}`);
  } else {
    console.log(`${RED}${BOLD}${failures.length} of ${results.length} checks failed.${NC}`);
  }
  await prisma.$disconnect();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
