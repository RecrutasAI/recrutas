#!/bin/bash
# Standby for Vercel: serve the website and the API from the VPS when Vercel is down.
# Off by default: nothing runs and nothing is built until `up`. See README.md here.
#
#   ssh root@<vps> 'bash /opt/recrutas/app/infra/vps/standby/site-standby.sh up'
#   ssh root@<vps> 'bash /opt/recrutas/app/infra/vps/standby/site-standby.sh status'
#   ssh root@<vps> 'bash /opt/recrutas/app/infra/vps/standby/site-standby.sh down'
#   ssh root@<vps> 'bash /opt/recrutas/app/infra/vps/standby/site-standby.sh check'  # drill: API + site files, no traffic
#
# `up` serves the prebuilt site (ship-site.sh), starts the API on 127.0.0.1:5000 and
# has Caddy serve www.recrutas.ai + recrutas.ai. Traffic only arrives once DNS points
# here (A records www and @ -> this VPS); Caddy then gets HTTPS certificates by itself.
set -euo pipefail

APP=/opt/recrutas/app
SITE=/etc/caddy/sites/recrutas-site.caddy
WEB=/opt/recrutas/standby-site
UNIT=/etc/systemd/system/recrutas-api-standby.service

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

ensure_caddy() {
  if ! command -v caddy >/dev/null; then
    apt-get update -qq
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  mkdir -p /etc/caddy/sites
  # One Caddyfile that loads every site file (sign-in backup, this standby).
  printf '# Sites: one file each in /etc/caddy/sites (infra/vps/auth, infra/vps/standby).\nimport sites/*.caddy\n' > /etc/caddy/Caddyfile
  systemctl enable caddy >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
}

reload_caddy() {
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
}

build_and_start_api() {
  # The VPS installs runtime packages only, so the site is built on the deploy machine and
  # copied here by ship-site.sh (run by push-deploy.sh). Nothing to build at failover time.
  say "Site files ($WEB)"
  if [ ! -f "$WEB/index.html" ]; then
    echo "No site files in $WEB. From the dev machine: bash infra/vps/standby/ship-site.sh" >&2
    exit 1
  fi
  echo "built from: $(cat "$WEB/.built-from" 2>/dev/null || echo unknown)"

  say "API on 127.0.0.1:5000 (VERCEL=1: no background jobs; the VPS crons already run them)"
  cat > "$UNIT" <<UNIT
[Unit]
Description=Recrutas API standby (serves while Vercel is down)
After=network-online.target postgresql.service pgbouncer.service

[Service]
WorkingDirectory=$APP
EnvironmentFile=$APP/.env
Environment=VERCEL=1
Environment=NODE_ENV=production
Environment=SUPABASE_POOLER_URL=
ExecStart=$APP/node_modules/.bin/tsx standalone-server.js
Restart=always
RestartSec=3
MemoryMax=700M

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl restart recrutas-api-standby
  for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:5000/api/health >/dev/null 2>&1 && break; sleep 2; done
  curl -fsS http://127.0.0.1:5000/api/health >/dev/null && echo "API up"
}

up() {
  build_and_start_api
  say "Caddy: www.recrutas.ai + recrutas.ai"
  ensure_caddy
  cat > "$SITE" <<CADDY
# Vercel standby (infra/vps/standby). Removed by \`site-standby.sh down\`.
recrutas.ai {
	redir https://www.recrutas.ai{uri} permanent
}
www.recrutas.ai {
	encode gzip
	handle /api/* {
		reverse_proxy 127.0.0.1:5000
	}
	handle {
		root * $WEB
		try_files {path} /index.html
		file_server
	}
}
CADDY
  reload_caddy
  echo
  echo "Standby is serving. Now point DNS at this VPS: A records 'www' and '@' -> $(curl -fsS -4 https://api.ipify.org || echo '<vps ip>')."
  echo "When Vercel is back: point DNS back, wait for it to spread, then run: site-standby.sh down"
}

down() {
  say "Stop the standby"
  rm -f "$SITE"
  [ -f /etc/caddy/Caddyfile ] && reload_caddy || true
  systemctl stop recrutas-api-standby 2>/dev/null || true
  systemctl disable recrutas-api-standby 2>/dev/null || true
  rm -f "$UNIT"; systemctl daemon-reload
  echo "Standby off."
}

status() {
  systemctl is-active recrutas-api-standby 2>/dev/null | sed 's/^/API standby: /' || true
  [ -f "$SITE" ] && echo "Caddy site: on" || echo "Caddy site: off"
  for h in www.recrutas.ai recrutas.ai; do echo "$h -> $(getent hosts "$h" | awk '{print $1}' | head -1)"; done
}

# A drill that takes no traffic: build, start the API, check it answers, stop it again.
check() {
  build_and_start_api
  say "Check"
  echo "health: $(curl -fsS http://127.0.0.1:5000/api/health | head -c 120)"
  echo "jobs:   $(curl -fsS http://127.0.0.1:5000/api/platform/stats | head -c 160)"
  echo "site:   $(wc -c < "$WEB/index.html") bytes index.html, $(ls "$WEB/assets" | wc -l) assets"
  systemctl stop recrutas-api-standby; systemctl disable recrutas-api-standby 2>/dev/null || true
  rm -f "$UNIT"; systemctl daemon-reload
  echo "Drill passed; standby stopped again."
}

case "${1:-status}" in
  up) up ;;
  check) check ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
