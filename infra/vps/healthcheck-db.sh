#!/usr/bin/env bash
# Health check for the self-hosted VPS Postgres. Because the VPS DB is now a
# single point of failure, this makes an outage LOUD instead of silent:
#   - verifies Postgres answers SELECT 1
#   - checks disk headroom (DB partition)
#   - records a 'vps-db-health' heartbeat in pipeline_runs so the admin Pipeline
#     Health panel flags it stale if the check stops running (or failed if degraded)
#
# Runs via run-cron.sh. Exits non-zero on failure so run-cron.sh logs it loudly.
set -uo pipefail

APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
PSQL="${PSQL_BIN:-/usr/lib/postgresql/17/bin/psql}"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"

cd "$APP_DIR" || { echo "[vps-db-health] cannot cd $APP_DIR" >&2; exit 1; }
set -a; # shellcheck disable=SC1091
source .env; set +a
URL="${POSTGRES_URL_NON_POOLING:-${POSTGRES_URL:-}}"
if [ -z "$URL" ]; then echo "[vps-db-health] no POSTGRES_URL_NON_POOLING/POSTGRES_URL" >&2; exit 1; fi

STARTED="$(date -u +%FT%TZ)"

# 1. Liveness
if ! "$PSQL" "$URL" -tAc 'SELECT 1' >/dev/null 2>/tmp/vps-db-health.err; then
  echo "[vps-db-health] DOWN: SELECT 1 failed — $(cat /tmp/vps-db-health.err)" >&2
  exit 1
fi

# 2. DB size + disk headroom
DB_SIZE="$("$PSQL" "$URL" -tAc "SELECT pg_size_pretty(pg_database_size(current_database()))" 2>/dev/null | tr -d ' ')"
DISK_PCT="$(df --output=pcent /var/lib/postgresql 2>/dev/null | tail -1 | tr -dc '0-9')"
DISK_PCT="${DISK_PCT:-0}"

STATUS=ok
MSG="db=${DB_SIZE} disk=${DISK_PCT}%"
if [ "$DISK_PCT" -ge "$DISK_WARN_PCT" ]; then
  STATUS=warning
  MSG="LOW DISK: ${DISK_PCT}% used on DB partition (db=${DB_SIZE})"
  echo "[vps-db-health] $MSG" >&2
fi

# 3. Heartbeat into pipeline_runs (best-effort; never fail the check on a write error)
"$PSQL" "$URL" -v ON_ERROR_STOP=0 -q >/dev/null 2>&1 <<SQL || true
INSERT INTO pipeline_runs (pipeline, status, started_at, finished_at, items_processed, message, stats)
VALUES ('vps-db-health', '${STATUS}', '${STARTED}', now(), 0,
        '$(printf '%s' "$MSG" | sed "s/'/''/g")',
        jsonb_build_object('dbSize', '${DB_SIZE}', 'diskPct', ${DISK_PCT}));
SQL

echo "[vps-db-health] ${STATUS}: ${MSG}"
[ "$STATUS" = warning ] && exit 1 || exit 0
