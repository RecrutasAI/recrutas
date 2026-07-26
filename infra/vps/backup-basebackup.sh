#!/usr/bin/env bash
# Weekly physical base backup — the other half of point-in-time recovery.
#
# The nightly pg_dump is a LOGICAL snapshot: restoring it puts you at 09:30 and
# nothing else. WAL segments cannot be replayed onto it. PITR requires a
# PHYSICAL base backup (this) plus the archived WAL (archive-wal.sh); together
# they let you restore to any moment since this backup was taken.
#
# Restore sketch:
#   systemctl stop postgresql@17-main
#   mv /var/lib/postgresql/17/main{,.broken}
#   mkdir -p /var/lib/postgresql/17/main && tar xzf base.tar.gz -C ...
#   # recovery.signal + restore_command =
#   #   'gunzip -c /opt/recrutas/backups/wal/%f.gz > %p'   (archive is gzipped)
#   # optional: recovery_target_time = '2026-07-26 09:15:00 UTC'
#   systemctl start postgresql@17-main
#
# Runs via run-cron.sh (lock + timeout + log + failure alert).
set -uo pipefail

APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
BASE_DIR="${BASEBACKUP_DIR:-/opt/recrutas/backups/basebackup}"
WAL_DIR="${WAL_ARCHIVE_DIR:-/opt/recrutas/backups/wal}"
KEEP="${BASEBACKUP_KEEP:-2}"
PG_BASEBACKUP="${PG_BASEBACKUP_BIN:-/usr/lib/postgresql/17/bin/pg_basebackup}"
PG_ARCHIVECLEANUP="${PG_ARCHIVECLEANUP_BIN:-/usr/lib/postgresql/17/bin/pg_archivecleanup}"
PSQL="${PSQL_BIN:-/usr/lib/postgresql/17/bin/psql}"

cd "$APP_DIR" || { echo "[basebackup] cannot cd $APP_DIR" >&2; exit 1; }
set -a; # shellcheck disable=SC1091
source .env; set +a

STARTED="$(date -u +%FT%TZ)"
DB_URL="${POSTGRES_URL_NON_POOLING:-${POSTGRES_URL:-}}"

heartbeat() { # status, message, bytes
  [ -z "$DB_URL" ] && return 0
  "$PSQL" "$DB_URL" -v ON_ERROR_STOP=0 -q >/dev/null 2>&1 <<SQL || true
INSERT INTO pipeline_runs (pipeline, status, started_at, finished_at, items_processed, message, stats)
VALUES ('basebackup', '$1', '${STARTED}', now(), ${3:-0},
        '$(printf '%s' "$2" | sed "s/'/''/g")', jsonb_build_object('bytes', ${3:-0}));
SQL
}

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BASE_DIR/base-$TS"
mkdir -p "$OUT"
# pg_basebackup runs as postgres (peer auth on the local socket), so it must own
# the destination this script just created as root.
chown postgres:postgres "$OUT"

# Record where this backup starts in the WAL stream, so WAL older than the
# oldest backup we still keep can be pruned safely.
START_WAL="$("$PSQL" "$DB_URL" -tAc "SELECT pg_walfile_name(pg_current_wal_lsn())" 2>/dev/null | tr -d ' ')"

# -Ft -z   tar + gzip; -Xstream bundles the WAL needed to make THIS backup
#          self-consistent, so it restores standalone even with no archive.
# -c fast  don't wait for the next natural checkpoint.
# The error log MUST live outside $OUT: pg_basebackup refuses a destination that
# is not empty, and a redirect into it would create the file first.
ERR="$BASE_DIR/.pg_basebackup-$TS.err"
if ! sudo -u postgres "$PG_BASEBACKUP" -D "$OUT" -Ft -z -Xstream -c fast \
      --no-password 2>"$ERR"; then
  echo "[basebackup] pg_basebackup failed:" >&2
  cat "$ERR" >&2
  rm -rf "$OUT" "$ERR"
  heartbeat failed "pg_basebackup failed"
  exit 1
fi
rm -f "$ERR"

[ -n "$START_WAL" ] && echo "$START_WAL" > "$OUT/START_WAL"
SIZE="$(du -sb "$OUT" | cut -f1)"
echo "[basebackup] wrote $OUT ($(numfmt --to=iec "$SIZE")), startWal=${START_WAL:-unknown}"

# Sanity: a base backup missing its main tarball is not a backup.
if [ ! -f "$OUT/base.tar.gz" ]; then
  echo "[basebackup] base.tar.gz missing — backup is not usable" >&2
  rm -rf "$OUT"
  heartbeat failed "base.tar.gz missing"
  exit 1
fi

# --- Retention ---------------------------------------------------------------
# Drop old base backups, keeping the newest $KEEP.
mapfile -t ALL < <(ls -1d "$BASE_DIR"/base-* 2>/dev/null | sort)
COUNT=${#ALL[@]}
if [ "$COUNT" -gt "$KEEP" ]; then
  for old in "${ALL[@]:0:$((COUNT - KEEP))}"; do
    echo "[basebackup] pruning $old"
    rm -rf "$old"
  done
fi

# Prune archived WAL older than the OLDEST base backup we still hold. Anything
# older can no longer be replayed onto any backup we have, so it is dead weight
# — and WAL is what fills the disk.
OLDEST="$(ls -1d "$BASE_DIR"/base-* 2>/dev/null | sort | head -1)"
if [ -n "$OLDEST" ] && [ -f "$OLDEST/START_WAL" ] && [ -x "$PG_ARCHIVECLEANUP" ]; then
  CUTOFF="$(cat "$OLDEST/START_WAL")"
  BEFORE="$(find "$WAL_DIR" -type f 2>/dev/null | wc -l)"
  # -x .gz because archive-wal.sh stores segments compressed.
  "$PG_ARCHIVECLEANUP" -x .gz "$WAL_DIR" "$CUTOFF" 2>/dev/null || true
  AFTER="$(find "$WAL_DIR" -type f 2>/dev/null | wc -l)"
  echo "[basebackup] WAL pruned to $CUTOFF: $BEFORE -> $AFTER segments"
fi

WALSZ="$(du -sh "$WAL_DIR" 2>/dev/null | cut -f1)"
MSG="base $(numfmt --to=iec "$SIZE"), $(ls -1d "$BASE_DIR"/base-* 2>/dev/null | wc -l) kept, WAL archive ${WALSZ:-0}"
echo "[basebackup] $MSG"
heartbeat ok "$MSG" "$SIZE"
