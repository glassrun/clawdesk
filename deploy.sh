#!/bin/bash
# deploy.sh — deploy ClawDesk backend
# Usage: ./deploy.sh

set -e

cd /home/openclaw/.openclaw/workspace/clawdesk

echo ">>> Checking for uncommitted changes..."
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: uncommitted changes. Commit or stash first."
  exit 1
fi

echo ">>> Pulling latest main..."
git pull origin main

echo ">>> Installing dependencies..."
cd backend && npm install --silent && cd ..

echo ">>> Running smoke test..."
node backend/tests/smoke.test.js

echo ">>> Starting new server..."
cd /home/openclaw/.openclaw/workspace/clawdesk/backend && node server.js &
NEW_PID=$!

# Wait for new server to be ready
echo ">>> Waiting for new server to be ready..."
for i in $(seq 1 20); do
  if curl -sf http://localhost:3777/health > /dev/null 2>&1; then
    echo "    new server up (pid $NEW_PID)"
    break
  fi
  sleep 1
done

echo ">>> Signaling old server to restart..."
curl -s -X POST http://localhost:3777/api/admin/restart || true

echo ""
echo ">>> Deploy complete."
