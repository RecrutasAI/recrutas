#!/bin/bash
# Our own sign-in server on the VPS: Supabase Auth (open source; same tokens and API as
# Supabase's hosted sign-in) running against our Postgres, in schema `auth`.
# Step 1 of infra/vps/auth/README.md. Safe to re-run. Nothing changes for users until
# the app is pointed at it (the cutover step, done separately).
#
#   ssh root@<vps> 'bash /opt/recrutas/app/infra/vps/auth/setup-auth.sh'
set -euo pipefail

VERSION=v2.197.0
SHA256=b5c2991d1df760c9b099c1c2395a94bd1c2f83ed58901934921997179dc9f7ea
DIR=/opt/recrutas/auth
APP_ENV=/opt/recrutas/app/.env
AUTH_ENV=$DIR/auth.env
DB=recrutas

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
appvar() { grep "^$1=" "$APP_ENV" | head -1 | cut -d= -f2- | tr -d '"'; }

mkdir -p "$DIR"
cd "$DIR"

say "Binary ($VERSION)"
if [ ! -x ./auth ] || [ "$(cat .version 2>/dev/null)" != "$VERSION" ]; then
  curl -fsSL -o auth.tar.xz "https://github.com/supabase/auth/releases/download/$VERSION/auth-$VERSION-amd64.tar.xz"
  echo "$SHA256  auth.tar.xz" | sha256sum -c -
  rm -rf migrations && tar -xJf auth.tar.xz && rm auth.tar.xz
  echo "$VERSION" > .version
fi
./auth --help >/dev/null && echo "ok: $(cat .version)"

say "Database role and config ($AUTH_ENV)"
if [ -f "$AUTH_ENV" ]; then
  echo "config exists, left as is (edit by hand; this script never overwrites it)"
else
  umask 077
  PW=$(openssl rand -hex 24)
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$DB" -v pw="$PW" <<'SQL'
SELECT format('CREATE ROLE recrutas_auth LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recrutas_auth') \gexec
SELECT format('ALTER ROLE recrutas_auth PASSWORD %L', :'pw') \gexec
SQL
  cat > "$AUTH_ENV" <<ENV
# Our own sign-in server. Secrets: never commit. See infra/vps/auth/README.md.
GOTRUE_DB_DRIVER=postgres
DATABASE_URL="postgres://recrutas_auth:$PW@127.0.0.1:5432/$DB?sslmode=disable&search_path=auth"
GOTRUE_DB_NAMESPACE=auth
GOTRUE_API_HOST=127.0.0.1
PORT=9999
# Public address: Caddy maps https://auth.recrutas.ai/auth/v1/* here, the same paths as Supabase.
API_EXTERNAL_URL=https://auth.recrutas.ai/auth/v1
GOTRUE_SITE_URL=https://www.recrutas.ai
GOTRUE_URI_ALLOW_LIST=https://www.recrutas.ai/**,https://recrutas.ai/**
# Same secret as Supabase, so the API (server/middleware/auth.ts) accepts these tokens unchanged.
GOTRUE_JWT_SECRET=$(appvar SUPABASE_JWT_SECRET)
GOTRUE_JWT_EXP=3600
GOTRUE_JWT_AUD=authenticated
GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
GOTRUE_JWT_ADMIN_ROLES=service_role
GOTRUE_DISABLE_SIGNUP=false
GOTRUE_EXTERNAL_EMAIL_ENABLED=true
# Matches Supabase today: accounts are confirmed on sign-up.
GOTRUE_MAILER_AUTOCONFIRM=true
GOTRUE_SMTP_HOST=smtp.resend.com
GOTRUE_SMTP_PORT=465
GOTRUE_SMTP_USER=resend
GOTRUE_SMTP_PASS=$(appvar RESEND_API_KEY)
GOTRUE_SMTP_ADMIN_EMAIL=noreply@recrutas.ai
GOTRUE_SMTP_SENDER_NAME=Recrutas
# Step 3 (README): Google sign-in and the Turnstile bot check, filled in by hand.
GOTRUE_EXTERNAL_GOOGLE_ENABLED=false
GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=
GOTRUE_EXTERNAL_GOOGLE_SECRET=
GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI=https://auth.recrutas.ai/auth/v1/callback
GOTRUE_SECURITY_CAPTCHA_ENABLED=false
GOTRUE_SECURITY_CAPTCHA_PROVIDER=turnstile
GOTRUE_SECURITY_CAPTCHA_SECRET=
# Headers supabase-js sends from the browser (CORS).
GOTRUE_CORS_ALLOWED_HEADERS=apikey,x-client-info,x-supabase-api-version
GOTRUE_LOG_LEVEL=info
ENV
  echo "written (role recrutas_auth; its password lives only in this file)"
fi
# Readable by the service user only.
chown root:nogroup "$AUTH_ENV"
chmod 640 "$AUTH_ENV"

say "Schema and migrations"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$DB" <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION recrutas_auth;
ALTER ROLE recrutas_auth SET search_path = auth;
GRANT CONNECT ON DATABASE recrutas TO recrutas_auth;
SQL
set -a; . "$AUTH_ENV"; set +a
./auth migrate
sudo -u postgres psql -At "$DB" -c "select 'migrations: ' || count(*) || ' (latest ' || max(version) || ')' from auth.schema_migrations"

say "Service (recrutas-auth, listening on 127.0.0.1:9999 only)"
cat > /etc/systemd/system/recrutas-auth.service <<UNIT
[Unit]
Description=Recrutas sign-in server (Supabase Auth $VERSION)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
EnvironmentFile=$AUTH_ENV
WorkingDirectory=$DIR
ExecStart=$DIR/auth serve
Restart=always
RestartSec=3
MemoryMax=256M
NoNewPrivileges=true
User=nobody
Group=nogroup

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable recrutas-auth >/dev/null
systemctl restart recrutas-auth
for _ in $(seq 1 20); do curl -fsS http://127.0.0.1:9999/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:9999/health && echo
echo "Next: sync-auth-users.sh (copy accounts from Supabase), then enable-public.sh once DNS exists."
