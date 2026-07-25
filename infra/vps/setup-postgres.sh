#!/usr/bin/env bash
# Provision self-hosted PostgreSQL 17 + pgvector on the VPS.
#
# Why: the app's DB outgrew Supabase Free (500MB hard cap / Fair-Use 402s).
# server/db.ts is provider-agnostic (postgres.js over a connection string), so
# moving the DB is an env flip — this script stands up the target it flips to.
#
# SAFE BY DEFAULT: Postgres binds to localhost only. Remote exposure (needed
# because Vercel has no static IP) is a SEPARATE, deliberate step gated behind
# EXPOSE_REMOTE=1 — never opened implicitly. Run that only once the firewall,
# SSL and a strong app password are in place (see the EXPOSE_REMOTE block).
#
# Idempotent: safe to re-run. Run as root on the VPS:
#   bash /opt/recrutas/app/infra/vps/setup-postgres.sh
#
# Env knobs:
#   PG_APP_DB        (default: recrutas)        target database name
#   PG_APP_ROLE      (default: recrutas_app)    non-superuser owner role
#   PG_APP_PASSWORD  (required on first run)    app role password (store it safely)
#   EXPOSE_REMOTE    (default: 0)               1 = also open for SSL remote access
set -euo pipefail

PG_VERSION=17
PG_APP_DB="${PG_APP_DB:-recrutas}"
PG_APP_ROLE="${PG_APP_ROLE:-recrutas_app}"
EXPOSE_REMOTE="${EXPOSE_REMOTE:-0}"
PGCONF_DIR="/etc/postgresql/${PG_VERSION}/main"
PGDATA_CONF="${PGCONF_DIR}/postgresql.conf"
PGHBA="${PGCONF_DIR}/pg_hba.conf"
CONF_D="${PGCONF_DIR}/conf.d"

echo "==> Installing PostgreSQL ${PG_VERSION} + pgvector (PGDG repo already configured)"
apt-get update -qq
apt-get install -y -qq "postgresql-${PG_VERSION}" "postgresql-${PG_VERSION}-pgvector"

systemctl enable postgresql >/dev/null 2>&1 || true
systemctl start postgresql

echo "==> Performance tuning for a 1.9GB box shared with cron jobs"
mkdir -p "$CONF_D"
# include_dir is default-on in Debian/Ubuntu packaging, but assert it so a
# re-run on a hand-edited conf still picks up our drop-in.
if ! grep -qE "^\s*include_dir\s*=\s*'conf\.d'" "$PGDATA_CONF"; then
  echo "include_dir = 'conf.d'" >> "$PGDATA_CONF"
fi
cat > "${CONF_D}/10-recrutas-tuning.conf" <<'EOF'
# Conservative: Postgres shares 1.9GB RAM with 11 tsx cron jobs. Sized so PG
# and a scraper peak don't OOM together; cron schedule is already staggered.
shared_buffers = 256MB
effective_cache_size = 768MB
work_mem = 8MB
maintenance_work_mem = 128MB
# Vercel serverless opens ~3 conns/instance and scales horizontally; 60 leaves
# headroom over the localhost cron connections. App idle_timeout recycles fast.
# (If sustained concurrency grows, front with pgBouncer rather than raising this.)
max_connections = 60
# HNSW build/scan tuning for pgvector (matches app's SET LOCAL hnsw.ef_search).
max_parallel_maintenance_workers = 1
EOF

echo "==> Password encryption: scram-sha-256"
cat > "${CONF_D}/20-recrutas-auth.conf" <<'EOF'
password_encryption = scram-sha-256
EOF

echo "==> Self-signed server certificate for SSL (reused if present)"
SSL_CRT="${PGDATA_CONF%/*}/server.crt"
SSL_KEY="${PGDATA_CONF%/*}/server.key"
if [ ! -f "$SSL_KEY" ]; then
  openssl req -new -x509 -days 3650 -nodes -text \
    -out "$SSL_CRT" -keyout "$SSL_KEY" \
    -subj "/CN=recrutas-db" >/dev/null 2>&1
  chown postgres:postgres "$SSL_CRT" "$SSL_KEY"
  chmod 600 "$SSL_KEY"
fi
cat > "${CONF_D}/30-recrutas-ssl.conf" <<EOF
ssl = on
ssl_cert_file = '${SSL_CRT}'
ssl_key_file = '${SSL_KEY}'
EOF

echo "==> Listen addresses (localhost only unless EXPOSE_REMOTE=1)"
if [ "$EXPOSE_REMOTE" = "1" ]; then
  echo "listen_addresses = '*'" > "${CONF_D}/40-recrutas-listen.conf"
else
  echo "listen_addresses = 'localhost'" > "${CONF_D}/40-recrutas-listen.conf"
fi

echo "==> App role + database (idempotent)"
if [ -z "${PG_APP_PASSWORD:-}" ]; then
  # Only required when the role doesn't exist yet.
  ROLE_EXISTS="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${PG_APP_ROLE}'")"
  if [ "$ROLE_EXISTS" != "1" ]; then
    echo "ERROR: PG_APP_PASSWORD must be set to create role '${PG_APP_ROLE}'." >&2
    exit 1
  fi
else
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${PG_APP_ROLE}') THEN
    CREATE ROLE ${PG_APP_ROLE} LOGIN PASSWORD '${PG_APP_PASSWORD}';
  ELSE
    ALTER ROLE ${PG_APP_ROLE} WITH PASSWORD '${PG_APP_PASSWORD}';
  END IF;
END
\$\$;
SQL
fi

# Create DB owned by the app role if absent (CREATE DATABASE can't run in DO).
DB_EXISTS="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${PG_APP_DB}'")"
if [ "$DB_EXISTS" != "1" ]; then
  sudo -u postgres createdb -O "${PG_APP_ROLE}" "${PG_APP_DB}"
fi

# The app role must OWN the public schema so it can create tables/indexes when
# restoring the dump and when drizzle-kit push runs migrations. Without this,
# restoring as the app role fails and objects owned by postgres are unreadable
# to it ("permission denied for table ...").
sudo -u postgres psql -d "${PG_APP_DB}" -v ON_ERROR_STOP=1 \
  -c "ALTER SCHEMA public OWNER TO ${PG_APP_ROLE};" \
  -c "GRANT ALL ON SCHEMA public TO ${PG_APP_ROLE};"

echo "==> Enable required extensions in ${PG_APP_DB}"
# vector: native pgvector column + HNSW ANN index (job/candidate embeddings).
# pg_trgm: GIN trigram index behind the feed's title search (idx_job_postings_title_trgm).
sudo -u postgres psql -d "${PG_APP_DB}" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" \
  -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"

echo "==> pg_hba: localhost always; remote (SSL, scram) only if EXPOSE_REMOTE=1"
# Rebuild our managed block idempotently between markers.
sed -i '/# >>> recrutas managed >>>/,/# <<< recrutas managed <<</d' "$PGHBA"
{
  echo "# >>> recrutas managed >>>"
  echo "local   ${PG_APP_DB}   ${PG_APP_ROLE}                     scram-sha-256"
  echo "host    ${PG_APP_DB}   ${PG_APP_ROLE}   127.0.0.1/32      scram-sha-256"
  echo "host    ${PG_APP_DB}   ${PG_APP_ROLE}   ::1/128           scram-sha-256"
  if [ "$EXPOSE_REMOTE" = "1" ]; then
    # Remote clients (e.g. Vercel, no static IP) must use SSL + scram password.
    echo "hostssl ${PG_APP_DB}   ${PG_APP_ROLE}   0.0.0.0/0         scram-sha-256"
    echo "hostssl ${PG_APP_DB}   ${PG_APP_ROLE}   ::/0              scram-sha-256"
  fi
  echo "# <<< recrutas managed <<<"
} >> "$PGHBA"

echo "==> Restart to apply"
systemctl restart postgresql

echo ""
echo "Done. Postgres ${PG_VERSION} + pgvector up."
echo "  DB:   ${PG_APP_DB}   role: ${PG_APP_ROLE}"
echo "  Bind: $( [ "$EXPOSE_REMOTE" = "1" ] && echo 'ALL interfaces (SSL required)' || echo 'localhost only' )"
if [ "$EXPOSE_REMOTE" = "1" ]; then
  echo "  ⚠️  Ensure ufw allows 5432 ONLY as intended before relying on remote access."
fi
echo "  Local test: sudo -u postgres psql -d ${PG_APP_DB} -c 'SELECT extversion FROM pg_extension WHERE extname=''vector'';'"
