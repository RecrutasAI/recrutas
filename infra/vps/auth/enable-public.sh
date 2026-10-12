#!/bin/bash
# Put the backup sign-in server on the internet at https://auth.recrutas.ai, with the same
# paths as Supabase (/auth/v1/*), so the app and the extension can switch to it.
# Step 3 of infra/vps/auth/README.md. Needs the DNS record auth.recrutas.ai -> this VPS
# first (Caddy gets the HTTPS certificate on its own). Safe to re-run.
#
#   ssh root@<vps> 'bash /opt/recrutas/app/infra/vps/auth/enable-public.sh'
set -euo pipefail

HOST=auth.recrutas.ai

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "DNS"
ip=$(getent hosts "$HOST" | awk '{print $1}' | head -1 || true)
mine=$(curl -fsS -4 https://api.ipify.org || true)
if [ -z "$ip" ] || [ "$ip" != "$mine" ]; then
  echo "$HOST resolves to '${ip:-nothing}', this server is '$mine'. Add the A record first." >&2
  exit 1
fi
echo "$HOST -> $ip (this server)"

say "Caddy"
if ! command -v caddy >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
caddy version

cat > /etc/caddy/Caddyfile <<CADDY
# Backup sign-in server (infra/vps/auth). Only /auth/v1/* is served, as on Supabase.
$HOST {
	handle_path /auth/v1/* {
		reverse_proxy 127.0.0.1:9999
	}
	handle {
		respond "Not found" 404
	}
}
CADDY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

say "Firewall (80 for the certificate, 443 for sign-in)"
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw status | grep -E '^(80|443)/tcp'

say "Check"
for _ in $(seq 1 30); do curl -fsS "https://$HOST/auth/v1/health" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "https://$HOST/auth/v1/health" && echo
