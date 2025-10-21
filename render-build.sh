#!/usr/bin/env bash
set -euo pipefail

echo "=== Render build: starting ==="
echo "Node: $(node -v)"
echo "NPM:  $(npm -v)"
echo "PWD:  $(pwd)"
ls -la || true

# 1) Install server dependencies (prod only)
if [ -f package-lock.json ]; then
  echo "Using npm ci (lockfile found)"
  npm ci --omit=dev
else
  echo "Using npm install (no lockfile)"
  npm install --omit=dev
fi

# 2) Install Playwright Chromium locally (so the binary is in the build layer)
#    PLAYWRIGHT_BROWSERS_PATH=0 -> install into node_modules/.local-browsers
export PLAYWRIGHT_BROWSERS_PATH=0
npx --yes playwright --version || true
echo "Installing Playwright Chromium..."
npx --yes playwright install chromium

echo "=== Render build: done ==="
