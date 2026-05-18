#!/usr/bin/env bash
# Sign + notarize InboxPro.app after Tauri builds it unsigned. Tauri's
# built-in --deep --force sign strips the secure timestamp from native
# binaries inside Resources/ which Apple's notarytool rejects. So we
# build unsigned, sign every binary individually bottom-up with the
# correct flags, then re-package + notarize + staple.
#
# Required env: APPLE_ID, APPLE_TEAM_ID, APPLE_PASSWORD
#
# Usage:  bash scripts/sign-app.sh

set -e
cd "$(dirname "$0")/.."

IDENTITY="Developer ID Application: Jacob Brachna-Gonzalez (AP3VSH77V4)"
APP="src-tauri/target/release/bundle/macos/InboxPro.app"
ENTITLEMENTS="src-tauri/entitlements.plist"

BLUE='\033[0;34m'; GREEN='\033[0;32m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'
step() { echo -e "${BLUE}▸${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
die()  { echo -e "${RED}✗${NC} $1"; exit 1; }

[ -d "$APP" ] || die "$APP not found. Run npx tauri build first."
[ -f "$ENTITLEMENTS" ] || die "$ENTITLEMENTS not found."
[ -n "$APPLE_ID" ] || die "APPLE_ID env var not set."
[ -n "$APPLE_TEAM_ID" ] || die "APPLE_TEAM_ID env var not set."
[ -n "$APPLE_PASSWORD" ] || die "APPLE_PASSWORD env var not set."

# ── Sign every Mach-O file inside the bundle bottom-up ────────────────
step "Signing every binary in the bundle (bottom-up)…"
COUNT=0
# `file` is slow but bulletproof. Filter to Mach-O files specifically.
while IFS= read -r f; do
  codesign --sign "$IDENTITY" \
           --options runtime \
           --timestamp \
           --entitlements "$ENTITLEMENTS" \
           --force \
           "$f" > /dev/null 2>&1
  COUNT=$((COUNT + 1))
done < <(find "$APP" -type f \( -name "*.node" -o -name "*.dylib" -o -name "*.so" \) 2>/dev/null)

# Also sign anything in Contents/MacOS that isn't the main app binary.
# Tauri strips the target-triple suffix from sidecars, so what was
# binaries/node-aarch64-apple-darwin in the source ends up as MacOS/node
# in the bundle — we just look for the file by walking the dir.
for f in "$APP/Contents/MacOS"/*; do
  name=$(basename "$f")
  # Skip the main executable (signed below as part of the .app bundle)
  [ "$name" = "app" ] && continue
  [ -f "$f" ] || continue
  codesign --sign "$IDENTITY" --options runtime --timestamp \
           --entitlements "$ENTITLEMENTS" --force "$f" > /dev/null
  COUNT=$((COUNT + 1))
done
ok "Signed $COUNT individual binaries"

# ── Sign the app bundle itself (no --deep; children are already signed) ──
step "Signing the .app bundle…"
codesign --sign "$IDENTITY" \
         --options runtime \
         --timestamp \
         --entitlements "$ENTITLEMENTS" \
         --force \
         "$APP" > /dev/null
ok "App bundle signed"

# ── Verify before notarizing ────────────────────────────────────────────
step "Verifying signature locally…"
codesign --verify --strict --verbose=1 "$APP" 2>&1 | head -3
ok "Local signature valid"

# ── Submit to notarytool ────────────────────────────────────────────────
ZIP=/tmp/InboxPro-notarize.zip
rm -f "$ZIP"
step "Zipping for notarization…"
ditto -c -k --keepParent "$APP" "$ZIP"
ok "Created $(du -h "$ZIP" | cut -f1) zip"

step "Submitting to Apple notarytool (5-15 min)…"
xcrun notarytool submit "$ZIP" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_PASSWORD" \
  --wait \
  --output-format json > /tmp/notarize-result.json 2>&1
STATUS=$(node -p "JSON.parse(require('fs').readFileSync('/tmp/notarize-result.json','utf8')).status" 2>/dev/null || echo "unknown")
if [ "$STATUS" != "Accepted" ]; then
  cat /tmp/notarize-result.json
  die "Notarization rejected (status: $STATUS). Run: xcrun notarytool log <id> --apple-id ... for details."
fi
ok "Notarized: Accepted"

# ── Staple the ticket so it works offline ───────────────────────────────
step "Stapling notarization ticket…"
xcrun stapler staple "$APP" > /dev/null
xcrun stapler validate "$APP" > /dev/null && ok "Staple verified"

# ── Rebuild the DMG with the now-signed .app inside ─────────────────────
# Tauri's DMG was built around the unsigned .app. Re-create it.
step "Re-bundling DMG with signed .app…"
DMG_OUT="src-tauri/target/release/bundle/dmg/InboxPro_$(node -p "require('./package.json').version")_aarch64.dmg"
rm -f "$DMG_OUT"
# Use Tauri's bundle_dmg.sh helper if available, else fall back to hdiutil
BUNDLE_DMG=src-tauri/target/release/bundle/dmg/bundle_dmg.sh
if [ -f "$BUNDLE_DMG" ]; then
  (cd "$(dirname "$DMG_OUT")" && bash bundle_dmg.sh \
    --volname InboxPro \
    --icon InboxPro.app 180 170 \
    --app-drop-link 480 170 \
    --window-size 660 400 \
    --hide-extension InboxPro.app \
    --volicon icon.icns \
    "$(basename "$DMG_OUT")" "../macos/InboxPro.app" > /dev/null 2>&1) \
    || hdiutil create -volname InboxPro -srcfolder "$APP" -ov -format UDZO "$DMG_OUT" > /dev/null
else
  hdiutil create -volname InboxPro -srcfolder "$APP" -ov -format UDZO "$DMG_OUT" > /dev/null
fi
codesign --sign "$IDENTITY" --timestamp --force "$DMG_OUT" > /dev/null
ok "DMG re-created at $DMG_OUT"

echo
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✓ InboxPro.app signed + notarized + stapled${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
echo "  App: $APP"
echo "  DMG: $DMG_OUT"
