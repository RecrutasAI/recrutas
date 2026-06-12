#!/usr/bin/env bash
# Update the app on the VPS: pull main, reinstall deps if lockfile changed,
# refresh the crontab. Run on the server: /opt/recrutas/app/infra/vps/deploy.sh
set -euo pipefail

APP_DIR=/opt/recrutas/app
cd "$APP_DIR"

BEFORE=$(git rev-parse HEAD)
git pull --ff-only
AFTER=$(git rev-parse HEAD)

if ! git diff --quiet "$BEFORE" "$AFTER" -- package-lock.json; then
  npm ci
fi

crontab "$APP_DIR/infra/vps/crontab"
echo "Deployed $(git rev-parse --short HEAD) ($(git log -1 --format=%s))"
