#!/usr/bin/env bash
# Build a clean InboxPro zip for teammates. Excludes per-machine state
# (dev.db, logs, node_modules, build artifacts) so the archive only contains
# what every teammate needs.
#
# Usage: npm run bundle   →   ./dist/inbox-app-YYYY-MM-DD.zip
set -e

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

if [ ! -f package.json ] || [ ! -d extension ]; then
  echo "Run this from the inbox-app project root."
  exit 1
fi

STAMP=$(date +%Y-%m-%d)
DIST_DIR="dist"
ZIP_NAME="inbox-app-${STAMP}.zip"
ZIP_PATH="${DIST_DIR}/${ZIP_NAME}"

mkdir -p "$DIST_DIR"

# Remove any previous bundle from today so the zip is fresh
rm -f "$ZIP_PATH"

# Ensure the installer is executable before we zip (zip preserves mode bits)
chmod +x "Install InboxPro.command" 2>/dev/null || true
chmod +x setup.sh scripts/restart-prod.sh 2>/dev/null || true

echo -e "${BLUE}▸${NC} Building ${ZIP_NAME}…"

# Build the zip from the project root. -r recursive, exclusions cover
# per-machine and build artifacts that should never travel.
zip -r "$ZIP_PATH" . \
  -x "node_modules/*" \
  -x ".next/*" \
  -x "dist/*" \
  -x ".git/*" \
  -x "dev.db" \
  -x "dev.db-journal" \
  -x "prisma/dev.db" \
  -x "prisma/dev.db-journal" \
  -x "sync-events.log" \
  -x "captured-actions.log" \
  -x ".DS_Store" \
  -x "*.tsbuildinfo" \
  -x "next-env.d.ts" \
  -x ".env*" \
  > /dev/null

SIZE=$(du -h "$ZIP_PATH" | cut -f1)
echo -e "${GREEN}✓${NC} ${ZIP_PATH} (${SIZE})"
echo
echo "Share this zip with your teammate."
echo
echo "Their workflow:"
echo "  1. Unzip the file"
echo "  2. Double-click 'Install InboxPro.command' inside the unzipped folder"
echo "  3. Follow the on-screen instructions to load the Chrome extension"
echo
echo "Total time: ~5 min if they have Node, ~10 min if not (auto-installs via brew)."
echo
echo -e "${YELLOW}Tip:${NC} for updates, send a new zip and have them extract OVER their"
echo "existing folder (their dev.db is gitignored AND in their folder, so it stays"
echo "as long as they don't replace the whole directory)."
