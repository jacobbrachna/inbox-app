#!/usr/bin/env bash
# Build a shippable Relay.dmg (Path 2: static export + app:// + IPC).
#
#   1. next build  → emits out/ (Next.js static export)
#   2. build-api   → esbuild bundles src/app/api/**/route.ts into
#                    electron/api/*.js (CJS) so the main process can
#                    require() them directly.
#   3. electron-builder packages everything into a signed .dmg
#
# Required env for signing+notarization:
#   CSC_NAME              "Jacob Brachna-Gonzalez (AP3VSH77V4)"
#   APPLE_ID              jbg7697@icloud.com
#   APPLE_TEAM_ID         AP3VSH77V4
#   APPLE_PASSWORD        app-specific password (memory: apple_developer_signing.md)

set -e
cd "$(dirname "$0")/.."

BLUE='\033[0;34m'; GREEN='\033[0;32m'; NC='\033[0m'
step() { echo -e "${BLUE}▸${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }

source "$HOME/.nvm/nvm.sh" 2>/dev/null && nvm use 22 > /dev/null 2>&1 || true

step "Bundling API routes to electron/api/…"
# Bundle routes FIRST because step 2 (next build with output:export) chokes
# on the api/ directory. We move it out of the source tree during that
# build and restore it via the trap below.
node scripts/build-api.js > /tmp/electron-dist-api.log 2>&1 \
  || { tail -30 /tmp/electron-dist-api.log; exit 1; }
ok "Bundled $(find electron/api -name '*.js' | wc -l | tr -d ' ') route files"

step "Building Next.js static export (out/)…"
# Next.js's `output: export` will refuse to build any /api/ route that
# doesn't declare itself static. Since we ship the api/ folder via
# electron/api/ (the bundled CJS version), we hide src/app/api/ from
# the static export entirely.
STASH=/tmp/relay-api-stash-$$
mv src/app/api "$STASH"
restore_api() { [ -d "$STASH" ] && mv "$STASH" src/app/api; }
trap restore_api EXIT

npm run build > /tmp/electron-dist-build.log 2>&1 \
  || { restore_api; tail -30 /tmp/electron-dist-build.log; exit 1; }
restore_api
trap - EXIT
ok "Static export ready ($(find out -type f | wc -l | tr -d ' ') files)"

step "Patching @prisma/client wrappers for app.asar resolution…"
# Prisma 7's @prisma/client/{default,index}.js do `require('.prisma/client/default')`,
# which fails inside app.asar because the generated client lives in
# app.asar.unpacked (added by build/copy-prisma.js). Patch the wrappers to
# resolve via an absolute path when running from inside the asar bundle.
# We restore the originals on EXIT so dev workflows aren't affected.
node -e "
const fs = require('fs');
const targets = [
  'node_modules/@prisma/client/default.js',
  'node_modules/@prisma/client/index.js',
];
for (const t of targets) {
  fs.copyFileSync(t, t + '.orig');
  fs.writeFileSync(t, \`
const path = require('path');
const isAsar = __dirname.includes('app.asar') && !__dirname.includes('app.asar.unpacked');
const target = isAsar
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '.prisma', 'client', 'default')
  : '.prisma/client/default';
module.exports = { ...require(target) };
\`);
}
"
restore_prisma() {
  for t in node_modules/@prisma/client/default.js node_modules/@prisma/client/index.js; do
    [ -f "$t.orig" ] && mv "$t.orig" "$t"
  done
}
trap restore_prisma EXIT
ok "Wrappers patched (restored on exit)"

step "Running electron-builder (this can take a few minutes)…"
export CSC_NAME="${CSC_NAME:-Jacob Brachna-Gonzalez (AP3VSH77V4)}"
npx electron-builder --mac --arm64 2>&1 | tail -40
restore_prisma
trap - EXIT

echo
DMG=$(ls dist-electron/*.dmg 2>/dev/null | head -1 || echo "")
if [ -n "$DMG" ]; then
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  ✓ Built $DMG ($(du -h "$DMG" | cut -f1))${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  ls -lh dist-electron/*.dmg dist-electron/*.zip 2>/dev/null
else
  echo "No DMG produced — check the electron-builder output above."
  exit 1
fi
