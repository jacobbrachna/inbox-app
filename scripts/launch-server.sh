#!/usr/bin/env bash
# Smart server-start used by the Tauri wrapper on app launch. Behaviour:
#
#   1. Server already responding on :3030 → exit 0 immediately
#   2. .next build cache exists           → start prod server directly (fast)
#   3. No build cache                     → full rebuild, then start
#
# Spawns the server fully detached (nohup + disown) so the Tauri process
# isn't tethered to it. Tauri kills the server group on app quit via PID
# file written below.

set -e
cd "$(dirname "$0")/.."

LOG=/tmp/relay-prod.log
PIDFILE=/tmp/relay-prod.pid

# ── 1. Already running? ────────────────────────────────────────────────
if curl -sf -o /dev/null http://localhost:3030/api/state 2>/dev/null; then
  echo "ok: already running"
  exit 0
fi

# ── 2/3. Need to build? ────────────────────────────────────────────────
if [ ! -d ".next" ] || [ ! -f ".next/BUILD_ID" ]; then
  echo "→ first run: building bundle (~30s)…"
  npm install --silent 2>/dev/null || true
  grep -q DATABASE_URL .env 2>/dev/null || echo 'DATABASE_URL="file:./dev.db"' >> .env
  npx prisma generate > /dev/null 2>&1 || true
  npx prisma migrate deploy > /dev/null 2>&1 || true
  npm run build > /dev/null 2>&1 || { echo "✗ build failed"; exit 1; }
fi

# Kill any stale server holding the port
PID=$(lsof -nP -iTCP:3030 -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; sleep 0.5; fi

# ── Start ─────────────────────────────────────────────────────────────
echo "→ starting on :3030…"
nohup npm run start > "$LOG" 2>&1 &
NEW_PID=$!
disown
echo "$NEW_PID" > "$PIDFILE"

# Wait for readiness (up to 15s — first start can be slow)
for i in {1..30}; do
  sleep 0.5
  if curl -sf -o /dev/null http://localhost:3030/api/state 2>/dev/null; then
    echo "ok: $NEW_PID"
    exit 0
  fi
done

echo "✗ server didn't respond within 15s — see $LOG"
exit 1
