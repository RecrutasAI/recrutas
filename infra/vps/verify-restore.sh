#!/usr/bin/env bash
# Weekly PROOF that the nightly dump can actually be restored.
#
# A backup that has never been restored is a hypothesis, not a backup. Dumps can
# succeed nightly for months and still be unrestorable — truncated writes, a
# missing extension, a schema the dump flags don't cover. The failure is silent
# by construction: you find out during the incident.
#
# Restores the newest vps-db dump into a scratch database, checks it against the
# live database, and drops it. Read-only with respect to production: it only
# COUNTS rows in the live DB, never writes.
#
# Runs via run-cron.sh (lock + timeout + log + failure alert).
set -uo pipefail

APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
VPS_DIR="${RECRUTAS_VPS_BACKUP_DIR:-/opt/recrutas/backups/vps-db}"
PSQL="${PSQL_BIN:-/usr/lib/postgresql/17/bin/psql}"
MIN_FREE_MB="${VERIFY_MIN_FREE_MB:-2048}"

cd "$APP_DIR" || { echo "[verify-restore] cannot cd $APP_DIR" >&2; exit 1; }
set -a; # shellcheck disable=SC1091
source .env; set +a

STARTED="$(date -u +%FT%TZ)"
DB_URL="${POSTGRES_URL_NON_POOLING:-${POSTGRES_URL:-}}"
LIVE_DB="${PG_APP_DB:-recrutas}"
SCRATCH="verify_restore_$(date -u +%Y%m%d%H%M%S)"

heartbeat() { # status, message, tables
  [ -z "$DB_URL" ] && return 0
  "$PSQL" "$DB_URL" -v ON_ERROR_STOP=0 -q >/dev/null 2>&1 <<SQL || true
INSERT INTO pipeline_runs (pipeline, status, started_at, finished_at, items_processed, message)
VALUES ('verify-restore', '$1', '${STARTED}', now(), ${3:-0},
        '$(printf '%s' "$2" | sed "s/'/''/g")');
SQL
}

# Always drop the scratch DB, including on error/timeout — otherwise a failed
# run leaves a full copy of the database eating the disk it was verifying.
cleanup() {
  sudo -u postgres psql -q -c "DROP DATABASE IF EXISTS \"$SCRATCH\";" >/dev/null 2>&1
  rm -f /tmp/verify-restore-$$.err
}
trap cleanup EXIT

DUMP="$(ls -1t "$VPS_DIR"/recrutas-db-*.sql.gz 2>/dev/null | head -1)"
if [ -z "$DUMP" ]; then
  echo "[verify-restore] no dump found in $VPS_DIR" >&2
  heartbeat failed "no dump to verify"
  exit 1
fi
AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$DUMP") ) / 3600 ))
echo "[verify-restore] verifying $(basename "$DUMP") (${AGE_H}h old)"

# A dump nobody noticed had stopped being produced is its own failure mode.
if [ "$AGE_H" -gt 48 ]; then
  echo "[verify-restore] newest dump is ${AGE_H}h old — backups may have stopped" >&2
  heartbeat failed "newest dump is ${AGE_H}h old"
  exit 1
fi

FREE_MB="$(df --output=avail -m / | tail -1 | tr -d ' ')"
if [ "$FREE_MB" -lt "$MIN_FREE_MB" ]; then
  echo "[verify-restore] only ${FREE_MB}MB free, need ${MIN_FREE_MB}MB — skipping" >&2
  heartbeat warning "skipped: only ${FREE_MB}MB free"
  exit 0
fi

# --- Restore into a scratch database -----------------------------------------
sudo -u postgres psql -q -c "CREATE DATABASE \"$SCRATCH\";" >/dev/null 2>&1
sudo -u postgres psql -q -d "$SCRATCH" \
  -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;" >/dev/null 2>&1

# stdout to /dev/null: the dump's setval() calls print a result row each, which
# would bury the actual verification output in the cron log.
gunzip -c "$DUMP" | sudo -u postgres psql -q -d "$SCRATCH" \
  >/dev/null 2>/tmp/verify-restore-$$.err
RC=$?

# "schema public already exists" is expected — we create the DB before restoring.
ERRORS="$(grep -i '^ERROR' /tmp/verify-restore-$$.err 2>/dev/null \
          | grep -viE 'schema "public" already exists' | head -5)"
if [ "$RC" -ne 0 ] || [ -n "$ERRORS" ]; then
  echo "[verify-restore] restore reported errors:" >&2
  echo "$ERRORS" >&2
  heartbeat failed "restore errors: $(echo "$ERRORS" | head -1 | cut -c1-120)"
  exit 1
fi

# --- Compare against the live database ---------------------------------------
count() { sudo -u postgres psql -tAd "$1" -c "$2" 2>/dev/null | tr -d ' '; }

TBL_SQL="SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"
LIVE_TBLS="$(count "$LIVE_DB" "$TBL_SQL")"
REST_TBLS="$(count "$SCRATCH" "$TBL_SQL")"

FAILURES=""
[ "${LIVE_TBLS:-0}" != "${REST_TBLS:-0}" ] && \
  FAILURES="table count ${REST_TBLS} != live ${LIVE_TBLS}"

# Row counts. The dump is up to a day old and purge/ingest run daily, so exact
# equality is wrong — the check is that the data is THERE, not identical. A
# restored table at a fraction of live means truncation, which is the failure
# this is looking for.
for t in job_postings users candidate_users discovered_companies; do
  L="$(count "$LIVE_DB" "SELECT count(*) FROM \"$t\"")"
  R="$(count "$SCRATCH" "SELECT count(*) FROM \"$t\"")"
  if [ -z "$R" ]; then
    FAILURES="${FAILURES}; $t missing from restore"
    continue
  fi
  # Only ratio-check tables big enough for a ratio to mean anything.
  if [ "${L:-0}" -gt 100 ]; then
    if [ "$R" -lt $(( L / 2 )) ]; then
      FAILURES="${FAILURES}; $t restored $R vs live $L (<50%)"
    fi
  fi
  echo "[verify-restore]   $t: restored=$R live=$L"
done

# The dump is schema-only-useful if the biggest table came back empty.
BIG="$(count "$SCRATCH" "SELECT count(*) FROM job_postings")"
[ "${BIG:-0}" -eq 0 ] && FAILURES="${FAILURES}; job_postings restored EMPTY"

if [ -n "$FAILURES" ]; then
  echo "[verify-restore] FAILED:${FAILURES}" >&2
  heartbeat failed "restore verify failed:${FAILURES}" "$REST_TBLS"
  exit 1
fi

MSG="$(basename "$DUMP") restores clean: ${REST_TBLS} tables, job_postings=${BIG}"
echo "[verify-restore] OK — $MSG"
heartbeat ok "$MSG" "$REST_TBLS"
