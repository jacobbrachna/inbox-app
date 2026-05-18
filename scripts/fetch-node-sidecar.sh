#!/usr/bin/env bash
# Populate src-tauri/binaries/ with the Node.js binaries Tauri ships
# as sidecars. We don't commit them (100MB each).
#
# Strategy: copy the user's locally-installed Node for the current
# arch (matches what they tested with). Future enhancement: download
# official builds from nodejs.org for cross-arch.
#
# Usage:  bash scripts/fetch-node-sidecar.sh

set -e
cd "$(dirname "$0")/.."

ARCH=$(uname -m)
case "$ARCH" in
  arm64)  TRIPLE="aarch64-apple-darwin" ;;
  x86_64) TRIPLE="x86_64-apple-darwin" ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

mkdir -p src-tauri/binaries
TARGET="src-tauri/binaries/node-$TRIPLE"

if [ -x "$TARGET" ]; then
  echo "✓ $TARGET already present"
  "$TARGET" --version
  exit 0
fi

NODE=$(command -v node)
[ -n "$NODE" ] || { echo "✗ node not on PATH — install Node first (brew install node)."; exit 1; }

echo "→ copying $NODE → $TARGET"
cp "$NODE" "$TARGET"
chmod +x "$TARGET"
echo "✓ $("$TARGET" --version)"
