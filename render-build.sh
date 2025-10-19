#!/usr/bin/env bash
set -e

echo "==> Installing npm dependencies"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "==> Installing Playwright Chromium browser locally (PLAYWRIGHT_BROWSERS_PATH=0)"
# Browser in node_modules/.cache installieren, damit der Pfad zur Laufzeit sicher gefunden wird
export PLAYWRIGHT_BROWSERS_PATH=0
npx playwright install chromium

echo "==> Build finished"
