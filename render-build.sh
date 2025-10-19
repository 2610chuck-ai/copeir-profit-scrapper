#!/usr/bin/env bash
set -e
echo "==> Installing npm dependencies"
if command -v npm >/dev/null 2>&1; then
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
else
  echo "npm not found"; exit 1
fi
echo "==> Installing Playwright Chromium browser"
npx playwright install chromium
echo "==> Build finished"
