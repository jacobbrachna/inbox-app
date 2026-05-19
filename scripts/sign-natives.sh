#!/usr/bin/env bash
# Pre-sign every native binary (Node.js sidecar, .node bindings, .dylib)
# that will end up inside Relay.app's Resources/. Apple's notarytool
# requires every Mach-O file to be signed with Developer ID + secure
# timestamp + hardened runtime — Tauri only deep-signs the bundle root,
# so we have to handle the standalone tree ourselves before bundling.
#
# Run automatically via tauri.conf.json's beforeBuildCommand.

set -e
cd "$(dirname "$0")/.."

IDENTITY="Developer ID Application: Jacob Brachna-Gonzalez (AP3VSH77V4)"

# Skip silently if no signing identity is installed (dev builds / CI
# without certs). The build will still produce an unsigned .app — fine
# for local testing, will only fail at notarization.
if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "AP3VSH77V4"; then
  echo "(no signing identity found — skipping native sign)"
  exit 0
fi

sign_one() {
  local f="$1"
  if codesign --verify "$f" 2>/dev/null; then
    return 0  # already signed
  fi
  codesign --sign "$IDENTITY" \
           --options runtime \
           --timestamp \
           --force \
           "$f" 2>&1 | sed 's/^/  /'
}

echo "▸ Signing native binaries in .next/standalone …"
COUNT=0
while IFS= read -r f; do
  sign_one "$f"
  COUNT=$((COUNT + 1))
done < <(find .next/standalone -type f \( -name "*.node" -o -name "*.dylib" \) 2>/dev/null)
echo "✓ Signed $COUNT files in standalone tree"

# The Node sidecar lives in src-tauri/binaries/. Tauri signs it during
# bundling, but we re-sign here so it has the hardened-runtime flag
# (which Tauri sometimes drops when stripping/copying sidecars).
SIDECAR=src-tauri/binaries/node-aarch64-apple-darwin
if [ -f "$SIDECAR" ]; then
  echo "▸ Signing Node sidecar …"
  codesign --sign "$IDENTITY" \
           --options runtime \
           --timestamp \
           --force \
           "$SIDECAR" 2>&1 | sed 's/^/  /'
  echo "✓ Signed sidecar"
fi
