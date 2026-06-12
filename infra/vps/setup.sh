#!/usr/bin/env bash
# One-time bootstrap for a fresh Ubuntu VPS (tested target: Hetzner Ubuntu 24.04).
# Run as root: bash <(curl -fsSL https://raw.githubusercontent.com/RecrutasAI/recrutas/main/infra/vps/setup.sh)
# Then: scp your local .env to /opt/recrutas/app/.env and re-run to install the crontab.
set -euo pipefail

APP_DIR=/opt/recrutas/app
REPO=https://github.com/RecrutasAI/recrutas.git

echo "==> Timezone to UTC (cron schedules assume UTC)"
timedatectl set-timezone UTC

echo "==> Base packages"
apt-get update -qq
apt-get install -y -qq git curl build-essential

if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  echo "==> Node 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

echo "==> Clone/update repo"
mkdir -p /opt/recrutas/logs
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi

echo "==> npm ci"
cd "$APP_DIR"
npm ci

chmod +x infra/vps/run-cron.sh infra/vps/deploy.sh

if [ ! -f "$APP_DIR/.env" ]; then
  echo ""
  echo "!! No .env found. From your local machine run:"
  echo "     scp .env root@<this-server>:$APP_DIR/.env"
  echo "   then re-run this script to install the crontab."
  exit 1
fi
chmod 600 "$APP_DIR/.env"

echo "==> Install crontab"
crontab "$APP_DIR/infra/vps/crontab"
crontab -l | head -5

echo ""
echo "Done. Logs land in /opt/recrutas/logs/<job>.log"
echo "Smoke test: $APP_DIR/infra/vps/run-cron.sh enforce-response-sla 5 npx tsx scripts/enforce-response-sla.ts"
