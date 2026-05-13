#!/usr/bin/env bash
# InboxPro one-shot setup script.
# Run from the project root: bash setup.sh   OR   npm run setup

set -e

# ── Colors ─────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'

step()    { echo -e "${BLUE}▸${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
fail()    { echo -e "${RED}✗${NC} $1"; exit 1; }

IS_UPDATE=false
if [ "$1" = "--update" ]; then
  IS_UPDATE=true
fi

echo
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ "$IS_UPDATE" = true ]; then
  echo -e "${BLUE}  InboxPro update${NC}"
else
  echo -e "${BLUE}  InboxPro setup${NC}"
fi
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo

# Update mode: pull latest first
if [ "$IS_UPDATE" = true ]; then
  if [ -d .git ]; then
    step "Pulling latest from git"
    git pull --ff-only || warn "git pull failed — continuing with local code"
    success "Pulled latest"
  fi
fi

# ── 1. Verify we're in the right directory ─────────────────────────────────
if [ ! -f package.json ] || [ ! -d extension ]; then
  fail "Run this from the inbox-app project root."
fi

# ── 2. Check Node ──────────────────────────────────────────────────────────
step "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js not found. Install from https://nodejs.org or 'brew install node'"
fi
NODE_VERSION=$(node -v)
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node $NODE_VERSION found — Node 20+ recommended. Continuing anyway."
else
  success "Node $NODE_VERSION"
fi

# ── 3. Install dependencies ────────────────────────────────────────────────
step "Installing dependencies (1–2 minutes)"
npm install --silent || fail "npm install failed"
success "Dependencies installed"

# ── 4. Set up / migrate the database ──────────────────────────────────────
step "Applying database migrations"
npx prisma generate >/dev/null 2>&1 || fail "Prisma generate failed"
# migrate deploy is idempotent: creates DB on first run, applies pending
# migrations on subsequent runs. Safe for both fresh installs and updates.
npx prisma migrate deploy >/dev/null 2>&1 \
  || npx prisma migrate dev --name init --skip-seed --skip-generate >/dev/null 2>&1 \
  || fail "Prisma migration failed — check prisma/schema.prisma"
if [ "$IS_UPDATE" = true ]; then
  success "Database up to date"
else
  success "Database ready at ./dev.db"
fi

# ── 5. Check port 3030 ─────────────────────────────────────────────────────
step "Checking port 3030"
if lsof -i:3030 >/dev/null 2>&1; then
  warn "Port 3030 is already in use. To free it: ${DIM}kill \$(lsof -ti :3030)${NC}"
else
  success "Port 3030 is free"
fi

# ── 6. Done ────────────────────────────────────────────────────────────────
EXT_PATH="$(pwd)/extension"
echo
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ "$IS_UPDATE" = true ]; then
  echo -e "${GREEN}  ✓ Update complete${NC}"
else
  echo -e "${GREEN}  ✓ Setup complete${NC}"
fi
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo

if [ "$IS_UPDATE" = true ]; then
  echo "Next steps:"
  echo
  echo -e "  ${BLUE}1.${NC} Reload the Chrome extension:"
  echo "     • Open chrome://extensions → click the reload icon on InboxPro"
  echo
  echo -e "  ${BLUE}2.${NC} Restart the dev server:"
  echo -e "     ${DIM}\$${NC} ${GREEN}npm run dev${NC}"
  echo
  echo -e "  ${BLUE}3.${NC} Hard-refresh the app tab (Cmd+Shift+R)"
  echo
else
  echo "Next steps:"
  echo
  echo -e "  ${BLUE}1.${NC} Load the Chrome extension:"
  echo "     • Open Chrome → chrome://extensions"
  echo "     • Toggle 'Developer mode' on (top-right)"
  echo "     • Click 'Load unpacked'"
  echo -e "     • Select this folder: ${DIM}$EXT_PATH${NC}"
  echo
  echo -e "  ${BLUE}2.${NC} Start the app:"
  echo -e "     ${DIM}\$${NC} ${GREEN}npm run restart${NC}   ${DIM}(production)${NC}  or  ${GREEN}npm run dev${NC}   ${DIM}(dev mode)${NC}"
  echo
  echo -e "  ${BLUE}3.${NC} Open ${BLUE}http://localhost:3030${NC} — the wizard will guide you."
  echo
  echo "Make sure you're logged into LinkedIn in this same Chrome profile."
  echo
  echo -e "${DIM}Tip: for the easiest install, double-click ${NC}${BLUE}Install InboxPro.command${NC}${DIM} instead — it auto-installs Node, builds, starts the server, and opens Chrome.${NC}"
  echo
fi
