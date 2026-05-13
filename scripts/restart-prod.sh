#!/usr/bin/env bash
# Rebuild + restart InboxPro in production mode.
# Use after making code changes to a prod-running InboxPro:
#   npm run restart
#
# Builds the Next.js bundle, kills any process holding port 3030, then starts
# the production server in the background. Logs go to /tmp/inboxpro-prod.log.

set -e
cd "$(dirname "$0")/.."

echo "→ Building production bundle…"
npm run build 2>&1 | tail -3

# Kill anything on 3030 (dev server, previous prod, etc.)
PID=$(lsof -nP -iTCP:3030 -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "→ Stopping existing server (PID $PID)…"
  kill "$PID" 2>/dev/null || true
  # Wait up to 5s for port to free
  for i in {1..10}; do
    sleep 0.5
    if [ -z "$(lsof -nP -iTCP:3030 -sTCP:LISTEN -t 2>/dev/null)" ]; then
      break
    fi
  done
fi

echo "→ Starting prod server on :3030…"
LOG=/tmp/inboxpro-prod.log
nohup npm run start > "$LOG" 2>&1 &
NEW_PID=$!
disown

# Wait for it to actually start listening
for i in {1..20}; do
  sleep 0.5
  if curl -sf -o /dev/null http://localhost:3030/api/state 2>/dev/null; then
    echo "✓ Live at http://localhost:3030 (PID $NEW_PID) — log: $LOG"
    exit 0
  fi
done

echo "✗ Server didn't respond within 10s. Check log: $LOG"
tail -20 "$LOG"
exit 1
