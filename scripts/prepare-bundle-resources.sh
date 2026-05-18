#!/usr/bin/env bash
# Assemble all the runtime resources that need to ship inside InboxPro.app
# into a single src-tauri/resources/ tree. Tauri's `bundle.resources`
# glob-mapping flattens nested directory structure, so we copy ourselves
# into a single root directory and reference that root as a unit.
#
# Result layout:
#   src-tauri/resources/
#     server/             ← .next/standalone, with .next/static + public merged in
#     prisma/
#       dev.db.seed
#       schema.prisma
#
# Run automatically via tauri.conf.json beforeBuildCommand.

set -e
cd "$(dirname "$0")/.."

OUT=src-tauri/resources
rm -rf "$OUT"
mkdir -p "$OUT/server" "$OUT/prisma"

# Server tree: standalone + static + public merged in. The `-L` flag is
# critical — Next.js standalone uses symlinks internally (and Prisma 7's
# generated hashed-client dir is a symlink). We resolve them at copy
# time because the relative targets break once the tree moves into the
# .app bundle.
if [ -d ".next/standalone" ]; then
  cp -RL .next/standalone/ "$OUT/server/"
  [ -d ".next/static" ] && mkdir -p "$OUT/server/.next" && cp -RL .next/static "$OUT/server/.next/"
  [ -d "public" ] && cp -RL public "$OUT/server/"
  # Strip any leaked dev files
  rm -rf "$OUT/server/sn-samples" "$OUT/server/sync-events.log" "$OUT/server/.env"
  # Tauri's bundler strips nested node_modules/ directories. Move the
  # hashed Prisma client (and any other nested modules) up to the
  # top-level node_modules so Node's resolver finds them after Tauri's
  # strip. `cp -RL` resolves the symlinks at the same time.
  if [ -d "$OUT/server/.next/node_modules" ]; then
    cp -RL "$OUT/server/.next/node_modules/." "$OUT/server/node_modules/"
    rm -rf "$OUT/server/.next/node_modules"
  fi
fi

# Prisma seed + schema
cp prisma/dev.db.seed "$OUT/prisma/dev.db.seed"
cp prisma/schema.prisma "$OUT/prisma/schema.prisma"
[ -d prisma/migrations ] && cp -R prisma/migrations "$OUT/prisma/migrations"

echo "✓ Assembled bundle resources at $OUT ($(du -sh "$OUT" | cut -f1))"
