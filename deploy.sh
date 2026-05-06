#!/bin/bash
# deploy.sh — deploy ClawDesk backend
# Usage: ./deploy.sh [staging|production]
# Defaults to staging (local restart).

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

echo ">>> All checks passed. Deploy complete."