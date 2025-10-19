#!/usr/bin/env bash
set -e
echo "==> Installing npm dependencies"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
echo "==> Installing Playwright Chromium browser"
npx playwright install chromium
echo "==> Build finished"
