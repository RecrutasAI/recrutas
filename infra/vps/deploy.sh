#!/usr/bin/env bash
# Update the app on the VPS: pull main, reinstall deps if lockfile changed,
# refresh the crontab. Run on the server: /opt/recrutas/app/infra/vps/deploy.sh
set -euo pipefail

APP_DIR=/opt/recrutas/app
cd "$APP_DIR"

BEFORE=$(git rev-parse HEAD)
if ! git pull --ff-only; then
  cat >&2 <<'EOF'

[deploy] git pull failed. This box has no GitHub credentials and the repo is not
anonymously readable, so pulling cannot work until that is fixed. Ship a bundle
from the dev machine instead:

  git bundle create /tmp/sync.bundle ^<vps-head-sha> main
  scp /tmp/sync.bundle root@<server>:/tmp/
  ssh root@<server> 'cd /opt/recrutas/app \
    && git fetch /tmp/sync.bundle main \
    && git reset --hard FETCH_HEAD \
    && crontab infra/vps/crontab'

Silently skipping the update would leave the crons running stale code — which is
how server/lib/db-capacity.ts went missing here for ~4 weeks.
EOF
  exit 1
fi
AFTER=$(git rev-parse HEAD)

if ! git diff --quiet "$BEFORE" "$AFTER" -- package-lock.json; then
  npm ci
fi

crontab "$APP_DIR/infra/vps/crontab"
echo "Deployed $(git rev-parse --short HEAD) ($(git log -1 --format=%s))"
