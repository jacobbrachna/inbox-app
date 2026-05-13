#!/usr/bin/env bash
# InboxPro one-click installer for macOS.
# Double-click this file (or right-click → Open) to install + start InboxPro.
#
# - Auto-installs Node.js via Homebrew if missing
# - Runs database setup
# - Builds + starts the production server
# - Opens Chrome to chrome://extensions and localhost:3030
#
# After this finishes, follow the on-screen instructions to load the Chrome
# extension. Total user action: 1 double-click here + 3 clicks in Chrome.

# cd to the script's directory so paths work regardless of where they unzipped
cd "$(dirname "$0")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'

step()    { echo -e "${BLUE}▸${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
fail()    { echo -e "${RED}✗${NC} $1"; echo; read -p "Press Enter to close."; exit 1; }

clear
echo
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  InboxPro installer${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo

# 1. Verify we're in the right folder
if [ ! -f package.json ] || [ ! -d extension ]; then
  fail "This installer must live in the inbox-app folder. Make sure you unzipped first, then run it from inside that folder."
fi

# 2. Check Node, install via Homebrew if missing
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js not installed."
  if ! command -v brew >/dev/null 2>&1; then
    step "Installing Homebrew (Mac package manager) — this asks for your password once"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
      || fail "Homebrew install failed. See https://brew.sh"
  fi
  step "Installing Node.js…"
  brew install node || fail "Node install failed. Try installing manually from nodejs.org"
fi
NODE_VERSION=$(node -v)
success "Node $NODE_VERSION"

# 3. Run the existing setup script (npm install, prisma migrate, port check)
step "Setting up dependencies + database…"
bash setup.sh > /tmp/inboxpro-setup.log 2>&1 \
  || { tail -30 /tmp/inboxpro-setup.log; fail "Setup failed. See /tmp/inboxpro-setup.log"; }
success "Dependencies + database ready"

# 4. Build production bundle
step "Building production bundle (~30s)…"
npm run build > /tmp/inboxpro-build.log 2>&1 \
  || { tail -30 /tmp/inboxpro-build.log; fail "Build failed. See /tmp/inboxpro-build.log"; }
success "Production bundle ready"

# 5. Kill anything on port 3030, then start the server
if lsof -ti :3030 >/dev/null 2>&1; then
  step "Stopping previous InboxPro on port 3030…"
  kill "$(lsof -ti :3030)" 2>/dev/null || true
  sleep 1
fi

step "Starting InboxPro on http://localhost:3030 …"
nohup npm run start > /tmp/inboxpro-prod.log 2>&1 &
disown

# Wait up to 15s for the server to actually respond
for i in {1..30}; do
  sleep 0.5
  if curl -sf -o /dev/null http://localhost:3030/api/state 2>/dev/null; then
    break
  fi
done
if ! curl -sf -o /dev/null http://localhost:3030/api/state 2>/dev/null; then
  warn "Server didn't respond within 15s. Check /tmp/inboxpro-prod.log"
fi
success "InboxPro is running"

# 6. Open Chrome to chrome://extensions AND localhost:3030
EXT_PATH="$(pwd)/extension"
step "Opening Chrome…"
open -a "Google Chrome" "chrome://extensions" 2>/dev/null \
  || open "chrome://extensions" 2>/dev/null \
  || true
sleep 1
open -a "Google Chrome" "http://localhost:3030" 2>/dev/null \
  || open "http://localhost:3030" 2>/dev/null \
  || true

echo
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✓ InboxPro is ready${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
echo "ONE LAST STEP: load the Chrome extension."
echo
echo -e "  ${BLUE}1.${NC} In the ${DIM}chrome://extensions${NC} tab that just opened, toggle"
echo -e "     ${BLUE}Developer mode${NC} (top-right)."
echo
echo -e "  ${BLUE}2.${NC} Click ${BLUE}Load unpacked${NC}."
echo
echo -e "  ${BLUE}3.${NC} Select this folder:"
echo -e "     ${DIM}$EXT_PATH${NC}"
echo
echo "Then come back to the localhost:3030 tab and the wizard will take it from there."
echo
echo -e "${DIM}Server log: tail -f /tmp/inboxpro-prod.log${NC}"
echo -e "${DIM}To stop:   kill \$(lsof -ti :3030)${NC}"
echo
read -p "Press Enter to close this window."
