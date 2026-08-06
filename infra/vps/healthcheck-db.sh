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

# 2a. Backup partition. Once /opt/recrutas/backups is its own volume, a full
# backup disk no longer shows up in the DB-partition check above — and silence
# there would be indistinguishable from health while backups quietly stop.
# Checked separately (and only when it IS a separate mount, so this is a no-op
# on the single-disk layout).
BACKUP_DIR_CHK="${RECRUTAS_BACKUPS_ROOT:-/opt/recrutas/backups}"
if mountpoint -q "$BACKUP_DIR_CHK" 2>/dev/null; then
  BK_PCT="$(df --output=pcent "$BACKUP_DIR_CHK" 2>/dev/null | tail -1 | tr -dc '0-9')"
  BK_PCT="${BK_PCT:-0}"
  if [ "$BK_PCT" -ge "$DISK_WARN_PCT" ]; then
    STATUS=warning
    MSG="LOW DISK on BACKUP volume: ${BK_PCT}% used (db partition ${DISK_PCT}%, db=${DB_SIZE})"
    echo "[vps-db-health] $MSG" >&2
  else
    MSG="$MSG backup=${BK_PCT}%"
  fi
fi

# 2b. WAL archiver. If archive_command starts failing, Postgres refuses to
# recycle WAL and pg_wal grows until the disk is full and the database stops —
# so an unnoticed archiver failure turns PITR into an outage. Alert on a recent
# failure or on pg_wal growing past a sane bound.
#
# failed_count is CUMULATIVE and never decreases, so "failures in the last hour"
# stays true for an hour after the archiver has already recovered — which is a
# false alarm every 15 minutes on a channel whose whole value is being believed.
# The archiver is stuck only if the most recent EVENT was a failure, i.e. nothing
# has archived since. Compare the timestamps rather than counting.
ARCH="$("$PSQL" "$URL" -tAc "
  SELECT COALESCE(failed_count,0) || ' ' ||
         COALESCE(EXTRACT(EPOCH FROM (now() - last_failed_time))::bigint, 999999) || ' ' ||
         CASE WHEN last_failed_time IS NOT NULL
               AND (last_archived_time IS NULL OR last_failed_time > last_archived_time)
              THEN 1 ELSE 0 END
  FROM pg_stat_archiver" 2>/dev/null)"
ARCH_FAILED="$(echo "$ARCH" | awk '{print $1+0}')"
ARCH_AGE="$(echo "$ARCH" | awk '{print $2+0}')"
ARCH_STUCK="$(echo "$ARCH" | awk '{print $3+0}')"
WAL_MB="$(du -sm /var/lib/postgresql/17/main/pg_wal 2>/dev/null | cut -f1)"
WAL_MB="${WAL_MB:-0}"
WAL_MAX_MB="${WAL_MAX_MB:-4096}"

# A failure within the last hour is live only if nothing has archived since.
if [ "$ARCH_STUCK" -eq 1 ] && [ "$ARCH_AGE" -lt 3600 ]; then
  STATUS=warning
  MSG="WAL ARCHIVER FAILING: ${ARCH_FAILED} failures, last ${ARCH_AGE}s ago (pg_wal=${WAL_MB}MB, db=${DB_SIZE})"
  echo "[vps-db-health] $MSG" >&2
elif [ "$WAL_MB" -ge "$WAL_MAX_MB" ]; then
  STATUS=warning
  MSG="pg_wal BACKING UP: ${WAL_MB}MB (limit ${WAL_MAX_MB}MB) — archiving may be stuck (db=${DB_SIZE})"
  echo "[vps-db-health] $MSG" >&2
else
  MSG="$MSG wal=${WAL_MB}MB"
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
