#!/bin/bash
# Build the website on this (dev/deploy) machine and copy it to the VPS for the Vercel
# standby (site-standby.sh). The VPS has runtime packages only and does no building, so
# its load is unchanged. push-deploy.sh runs this after each deploy; safe to run by hand.
#
#   bash infra/vps/standby/ship-site.sh
set -euo pipefail

HOST="${VPS_HOST:-178.156.193.183}"
KEY="${VPS_SSH_KEY:-$HOME/.ssh/recrutas_cron}"
DEST=/opt/recrutas/standby-site
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

cd "$ROOT"
# Same public build settings as Vercel: the VITE_* values from .env.
(cd client && npx vite build --logLevel warn --outDir "$OUT/site" --emptyOutDir)
test -f "$OUT/site/index.html"
git log -1 --format='%h %s (%cI)' > "$OUT/site/.built-from"

ssh -o ConnectTimeout=10 -i "$KEY" "root@$HOST" "mkdir -p $DEST.new && rm -rf $DEST.new/*"
tar -C "$OUT/site" -czf - . | ssh -i "$KEY" "root@$HOST" "tar -C $DEST.new -xzf - && rm -rf $DEST.old && { [ -d $DEST ] && mv $DEST $DEST.old || true; } && mv $DEST.new $DEST && rm -rf $DEST.old"
echo "standby site: $(cat "$OUT/site/.built-from") -> $HOST:$DEST"
