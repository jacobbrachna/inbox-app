#!/usr/bin/env bash
# InboxPro bootstrap — run this once on a new Mac.
# Right-click → Open on first run (macOS security), double-click after that.
# Downloads InboxPro from GitHub and launches the full installer.

cd "$HOME"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'
step()    { echo -e "${BLUE}▸${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
fail()    { echo -e "${RED}✗${NC} $1"; echo; read -rp "Press Enter to close."; exit 1; }

clear
echo
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  InboxPro setup${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo

INSTALL_DIR="$HOME/Documents/inbox-app"

# ── 1. Homebrew ────────────────────────────────────────────────────────────
if ! command -v brew >/dev/null 2>&1; then
  step "Installing Homebrew (you may be asked for your Mac password once)…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || fail "Homebrew install failed. Visit https://brew.sh for help."
  # Add brew to PATH (Apple Silicon vs Intel)
  eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null \
    || eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null \
    || true
fi
success "Homebrew ready"

# ── 2. GitHub CLI ──────────────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
  step "Installing GitHub CLI…"
  brew install gh || fail "GitHub CLI install failed."
fi
success "GitHub CLI ready"

# ── 3. GitHub login ────────────────────────────────────────────────────────
if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo
  step "Connecting to GitHub — your browser will open to log in"
  echo -e "  ${DIM}Follow the prompts in your browser, then come back here.${NC}"
  echo
  gh auth login --hostname github.com --git-protocol https --web \
    || fail "GitHub login failed. Make sure you've accepted the invite email first."
  echo
fi
success "GitHub connected"

# ── 4. Clone or update ─────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  step "InboxPro already installed — pulling latest…"
  git -C "$INSTALL_DIR" pull --ff-only \
    || fail "Update failed. Try again or contact Jacob."
  success "Up to date"
else
  step "Downloading InboxPro…"
  gh repo clone jacobbrachna/inbox-app "$INSTALL_DIR" \
    || fail "Download failed. Make sure you accepted the GitHub invite email before running this."
  success "Downloaded to ~/Documents/inbox-app"
fi

# ── 5. Launch the installer ────────────────────────────────────────────────
echo
step "Launching installer — follow the window that opens…"
open "$INSTALL_DIR/Install InboxPro.command" \
  || fail "Could not open the installer. Try opening it manually from ~/Documents/inbox-app."

echo
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✓ Installer launched — you can close this window${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
read -rp "Press Enter to close."
