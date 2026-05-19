// Bundle every src/app/api/**/route.ts into electron/api/**/X.js so the
// Electron main process can require() them. esbuild handles TypeScript
// natively + aliases `next/server` to our shim so the route handlers
// don't drag in any of Next.js's server runtime.
//
// Each route.ts becomes electron/api/<path>.js. Example:
//   src/app/api/state/route.ts                  → electron/api/state.js
//   src/app/api/contacts/by-slug/[slug]/status/route.ts
//                                               → electron/api/contacts/by-slug/[slug]/status.js
//
// Usage:  node scripts/build-api.js

const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const glob = require('node:fs').globSync ?? null;

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/app/api');
const OUT = path.join(ROOT, 'electron/api');
const SHIM = path.join(ROOT, 'electron/next-server-shim.js');

function listRoutes(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listRoutes(p, acc);
    else if (entry.name === 'route.ts' || entry.name === 'route.js') acc.push(p);
  }
  return acc;
}

const routes = listRoutes(SRC);
console.log(`Bundling ${routes.length} route files…`);

// Each route bundles to <its dir relative to api>.js
// e.g. src/app/api/contacts/by-slug/[slug]/status/route.ts
//      → electron/api/contacts/by-slug/[slug]/status.js
const entryPoints = routes.map((r) => {
  const rel = path.relative(SRC, path.dirname(r));
  const outFile = path.join(OUT, rel + '.js');
  return { in: r, out: outFile.replace(/\.js$/, '') };
});

// Clean OUT first so removed routes don't linger
if (fs.existsSync(OUT)) {
  // Don't wipe — that would delete state.js, db.js. Just clean stale route bundles.
  // We do this by listing files NOT in our entry set and removing them.
  const wanted = new Set(entryPoints.map((e) => e.out + '.js'));
  // Preserve these hand-written files
  const preserved = new Set([
    path.join(OUT, 'state.js'), // proof-of-concept, will be replaced by bundled
  ]);
  function clean(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        clean(p);
        try { fs.rmdirSync(p); } catch {}
      } else if (e.name.endsWith('.js') && !wanted.has(p) && !preserved.has(p)) {
        fs.unlinkSync(p);
      }
    }
  }
  clean(OUT);
}

esbuild.buildSync({
  entryPoints: entryPoints.map((e) => ({ in: e.in, out: path.relative(OUT, e.out) })),
  outdir: OUT,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // External: keep these as runtime requires from electron/api/... — they
  // resolve to the project's node_modules, which Electron ships unchanged.
  external: [
    '@prisma/client',
    '@prisma/adapter-better-sqlite3',
    'better-sqlite3',
    '@anthropic-ai/sdk',
  ],
  alias: {
    'next/server': SHIM,
    // Convert @/lib/... imports (TypeScript path alias) to relative paths
    // by re-rooting them. We let esbuild resolve them via tsconfig.
    '@/lib': path.join(ROOT, 'src/lib'),
    '@/types': path.join(ROOT, 'src/types'),
    '@/store': path.join(ROOT, 'src/store'),
  },
  // Resolve TS path aliases via tsconfig
  tsconfig: path.join(ROOT, 'tsconfig.json'),
  // Don't minify — keeps stack traces readable
  minify: false,
  sourcemap: 'linked',
  logLevel: 'info',
});

console.log(`✓ Bundled to ${OUT}`);
