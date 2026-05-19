#!/usr/bin/env bash
# Ship a new Relay version. Builds + signs + notarizes the .app +
# .dmg + updater bundle, generates latest.json with the bundle signature,
# uploads everything to GitHub Releases.
#
# Usage:  bash scripts/release.sh           # uses version from package.json
#         bash scripts/release.sh 0.2.0     # explicit version
#
# Requires:
# - Rust + Tauri CLI installed (see scripts/bootstrap.sh)
# - gh CLI logged in (gh auth login)
# - Apple signing env vars: APPLE_ID, APPLE_TEAM_ID, APPLE_PASSWORD
# - Tauri signing key in src-tauri/.tauri-keys (or TAURI_SIGNING_PRIVATE_KEY)

set -e
cd "$(dirname "$0")/.."

BLUE='\033[0;34m'; GREEN='\033[0;32m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'
step() { echo -e "${BLUE}▸${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
die()  { echo -e "${RED}✗${NC} $1"; exit 1; }

# ── Version bookkeeping ──────────────────────────────────────────────
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION=$(node -p "require('./package.json').version")
fi
[ -z "$VERSION" ] && die "Could not determine version."
ok "Releasing v$VERSION"

# Sync the version into tauri.conf.json too so the .app version matches
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  cfg.version = '$VERSION';
  fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(cfg, null, 2) + '\n');
"

# ── Build (signed + notarized + updater artifacts) ───────────────────
[ -n "$APPLE_ID" ]      || die "APPLE_ID not set."
[ -n "$APPLE_TEAM_ID" ] || die "APPLE_TEAM_ID not set."
[ -n "$APPLE_PASSWORD" ] || die "APPLE_PASSWORD not set."
if [ -z "$TAURI_SIGNING_PRIVATE_KEY" ]; then
  KEYFILE="$PWD/src-tauri/.tauri-keys"
  [ -f "$KEYFILE" ] || die "src-tauri/.tauri-keys not found. Generate with: npx tauri signer generate"
  # Pass the contents directly — the _PATH variant occasionally trips on
  # the comment-line header in the keyfile depending on Tauri version.
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEYFILE")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
fi

step "Building v$VERSION (this takes a few minutes)…"
npx tauri build > /tmp/relay-release-build.log 2>&1 \
  || { tail -40 /tmp/relay-release-build.log; die "build failed."; }
ok "Built + notarized"

# ── Locate artifacts ──────────────────────────────────────────────────
APP="src-tauri/target/release/bundle/macos/Relay.app"
DMG=$(ls src-tauri/target/release/bundle/dmg/Relay_*.dmg 2>/dev/null | head -1)
UPDATER_TAR=$(ls src-tauri/target/release/bundle/macos/Relay.app.tar.gz 2>/dev/null | head -1)
UPDATER_SIG=$(ls src-tauri/target/release/bundle/macos/Relay.app.tar.gz.sig 2>/dev/null | head -1)

[ -d "$APP" ]          || die "Missing $APP"
[ -n "$DMG" ]          || die "Missing .dmg"
[ -n "$UPDATER_TAR" ]  || die "Missing updater .tar.gz (check createUpdaterArtifacts in tauri.conf.json)"
[ -n "$UPDATER_SIG" ]  || die "Missing updater signature"

SIG_CONTENT=$(cat "$UPDATER_SIG")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TAG="v$VERSION"

# ── latest.json (Tauri updater manifest) ──────────────────────────────
LATEST_JSON=/tmp/latest.json
cat > "$LATEST_JSON" <<EOF
{
  "version": "$VERSION",
  "notes": "Relay $VERSION",
  "pub_date": "$NOW",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$SIG_CONTENT",
      "url": "https://github.com/jacobbrachna/inbox-app/releases/download/$TAG/Relay.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "$SIG_CONTENT",
      "url": "https://github.com/jacobbrachna/inbox-app/releases/download/$TAG/Relay.app.tar.gz"
    }
  }
}
EOF
ok "Generated latest.json"

# ── Upload to GitHub Releases ─────────────────────────────────────────
command -v gh >/dev/null 2>&1 || die "gh CLI not installed. brew install gh, then gh auth login."

step "Creating GitHub release $TAG…"
if gh release view "$TAG" >/dev/null 2>&1; then
  echo -e "${DIM}  release $TAG already exists — uploading assets to it${NC}"
else
  gh release create "$TAG" --title "Relay $VERSION" --notes "Auto-generated release. See commits for details." \
    || die "gh release create failed."
fi

step "Uploading artifacts…"
gh release upload "$TAG" "$DMG" "$UPDATER_TAR" "$UPDATER_SIG" "$LATEST_JSON" --clobber \
  || die "gh release upload failed."
ok "Uploaded"

echo
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✓ Relay $VERSION shipped${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
echo "Users on older versions will see an Update available prompt on next launch."
echo "Manual download: https://github.com/jacobbrachna/inbox-app/releases/tag/$TAG"
