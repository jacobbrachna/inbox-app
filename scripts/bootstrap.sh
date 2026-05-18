#!/usr/bin/env bash
# First-run installer for InboxPro on a fresh Mac. Invoked by the Tauri
# wrapper when ~/Documents/inbox-app doesn't exist yet. Mirrors the
# Path-3 flow from the old GetInboxPro.app launcher: Homebrew → Node →
# git clone → npm install → prisma migrate → build.
#
# Writes /tmp/inboxpro-bootstrap-status (ok|fail|running) on each phase
# so the Tauri Rust side can poll progress and surface errors.
#
# Usage:  bash bootstrap.sh
# Notes:
# - Safe to re-run. Skips already-installed steps.
# - User can run this directly from Terminal too; the Tauri wrapper just
#   opens Terminal pointed at it.

set -e

INSTALL_DIR="$HOME/Documents/inbox-app"
REPO_URL="https://github.com/jacobbrachna/inbox-app.git"
STATUS=/tmp/inboxpro-bootstrap-status

BLUE='\033[0;34m'; GREEN='\033[0;32m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'

step()  { echo -e "${BLUE}▸${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
die()   { echo -e "${RED}✗${NC} $1"; echo "fail" > "$STATUS"; echo; read -rp "Press Enter to close." _; exit 1; }

echo "running" > "$STATUS"

clear
echo
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  InboxPro — first-run setup${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo

# ── Homebrew ──────────────────────────────────────────────────────────
if ! command -v brew >/dev/null 2>&1; then
  if [ -f /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -f /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  else
    step "Installing Homebrew (you may be prompted for your Mac password once)…"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
      || die "Homebrew install failed. Visit https://brew.sh for help."
    eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null \
      || eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null \
      || true
  fi
fi
ok "Homebrew ready"

# ── Node.js ──────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  step "Installing Node.js…"
  brew install node || die "Node.js install failed."
fi
ok "Node.js ready ($(node --version))"

# ── git (Xcode Command Line Tools usually provides it) ───────────────
if ! command -v git >/dev/null 2>&1; then
  step "Installing git via Xcode Command Line Tools (accept the dialog)…"
  xcode-select --install 2>/dev/null || true
  # Wait for the install dialog → completion
  until command -v git >/dev/null 2>&1; do
    sleep 5
    echo -e "${DIM}  waiting for git… (close the Xcode dialog if it errored, then re-run)${NC}"
  done
fi
ok "git ready"

# ── Clone the repo ───────────────────────────────────────────────────
if [ ! -d "$INSTALL_DIR/.git" ]; then
  step "Downloading InboxPro to $INSTALL_DIR…"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR" || die "git clone failed. Check internet connection."
fi
ok "Downloaded"

cd "$INSTALL_DIR"

# ── Install deps ─────────────────────────────────────────────────────
step "Installing npm dependencies (~30s)…"
npm install --silent 2>/dev/null || die "npm install failed."
ok "Dependencies installed"

# ── Env + Prisma ─────────────────────────────────────────────────────
grep -q DATABASE_URL .env 2>/dev/null || echo 'DATABASE_URL="file:./dev.db"' >> .env
step "Setting up database…"
npx prisma generate > /dev/null 2>&1 || die "prisma generate failed."
npx prisma migrate deploy > /dev/null 2>&1 \
  || npx prisma migrate dev --name init --skip-seed --skip-generate > /dev/null 2>&1 \
  || die "Database migration failed."
ok "Database ready"

# ── First build ──────────────────────────────────────────────────────
step "Building production bundle (~45s)…"
npm run build > /dev/null 2>&1 || die "next build failed. Run 'npm run build' for details."
ok "Build complete"

echo "ok" > "$STATUS"

echo
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✓ InboxPro is set up. The app will continue automatically.${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
echo "ONE LAST STEP: load the Chrome extension."
echo
echo -e "  ${BLUE}1.${NC} Open Chrome and visit:  ${DIM}chrome://extensions${NC}"
echo -e "  ${BLUE}2.${NC} Toggle ${DIM}Developer mode${NC} (top-right)"
echo -e "  ${BLUE}3.${NC} Click ${DIM}Load unpacked${NC}"
echo -e "  ${BLUE}4.${NC} Select:  ${DIM}$INSTALL_DIR/extension${NC}"
echo
sleep 4
exit 0
