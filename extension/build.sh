#!/usr/bin/env bash
# Build Recrutas extension for Chrome and Firefox
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="$DIR/dist"

rm -rf "$DIST"
mkdir -p "$DIST"

SHARED_FILES=(
  background.js
  content.js
  recrutas-bridge.js
  content.css
  popup.html
  popup.js
  popup.css
  browser-polyfill.js
  icons/icon16.png
  icons/icon48.png
  icons/icon128.png
)

# ── Chrome build ──────────────────────────────────────────────────────────────
echo "Building Chrome extension…"
CHROME_DIR="$DIST/chrome"
mkdir -p "$CHROME_DIR/icons"

cp "$DIR/manifest.chrome.json" "$CHROME_DIR/manifest.json"
for f in "${SHARED_FILES[@]}"; do
  cp "$DIR/$f" "$CHROME_DIR/$f"
done

(cd "$CHROME_DIR" && zip -r "$DIST/recrutas-chrome.zip" . -x ".*")
echo "  → dist/recrutas-chrome.zip"

# ── Firefox build ─────────────────────────────────────────────────────────────
echo "Building Firefox extension…"
FIREFOX_DIR="$DIST/firefox"
mkdir -p "$FIREFOX_DIR/icons"

cp "$DIR/manifest.firefox.json" "$FIREFOX_DIR/manifest.json"
for f in "${SHARED_FILES[@]}"; do
  cp "$DIR/$f" "$FIREFOX_DIR/$f"
done

(cd "$FIREFOX_DIR" && zip -r "$DIST/recrutas-firefox.zip" . -x ".*")
echo "  → dist/recrutas-firefox.zip"

echo "Done. Both packages in extension/dist/"
