#!/usr/bin/env bash
# Hard SPACE cap on the WAL archive — the safety valve under backup-basebackup.sh.
#
# Why this exists (2026-08-06 incident): retention was bounded by TIME but the
# disk is bounded by SPACE. backup-basebackup.sh prunes WAL back to the OLDEST
# base backup it keeps, so with BASEBACKUP_KEEP=2 weekly backups the archive
# holds 7-14 days of WAL. At the measured rate that reached 18GB on a 38GB disk
# and filled it, which broke archive_command with ENOSPC, which stopped Postgres
# from recycling pg_wal, which filled the disk further. A backup artifact took
# down the database it was protecting.
#
# Time-based retention cannot prevent that: any growth in write volume re-creates
# it. So this enforces the invariant the disk actually cares about — bytes.
#
# Degradation order matters. When over cap we give up PITR DEPTH (the ability to
# rewind to a point covered only by an OLDER base backup) before PITR EXISTENCE
# (the ability to rewind at all). Concretely: prune back to the NEWEST base
# backup and stop. Pruning past it would leave WAL that cannot be replayed onto
# any base backup we hold — i.e. silently no PITR, which is worse than a full
# disk because nothing tells you until you need to restore.
#
# If pruning to the newest base is STILL over cap, that means a single backup
# interval of WAL exceeds the cap. That is a capacity decision for a human
# (raise the cap, shorten the basebackup interval, or cut WAL volume), so we
# alert and exit non-zero rather than delete anything further.
#
# Runs via run-cron.sh (lock + timeout + log + failure alert).
set -uo pipefail

APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
BASE_DIR="${BASEBACKUP_DIR:-/opt/recrutas/backups/basebackup}"
WAL_DIR="${WAL_ARCHIVE_DIR:-/opt/recrutas/backups/wal}"
PG_ARCHIVECLEANUP="${PG_ARCHIVECLEANUP_BIN:-/usr/lib/postgresql/17/bin/pg_archivecleanup}"
PSQL="${PSQL_BIN:-/usr/lib/postgresql/17/bin/psql}"
ALERT="$APP_DIR/infra/vps/alert.sh"

cd "$APP_DIR" || { echo "[prune-wal-cap] cannot cd $APP_DIR" >&2; exit 1; }
set -a; # shellcheck disable=SC1091
source .env; set +a

# Cap in MB. MUST be read AFTER sourcing .env — it was computed before, which
# made WAL_ARCHIVE_MAX_MB in .env dead config that silently did nothing (found
# 2026-08-07: set it to 10240, script still reported "cap 20480MB" and declined
# to prune while the disk climbed).
#
# Default 10GB, sized against the measured ~3.3GB/day of WAL: with the DAILY
# basebackup this now sits under, one interval costs ~3.3GB, so 10GB is ~3x
# headroom. Raising the basebackup interval without raising this cap puts the
# script straight into its own "one interval exceeds the cap" alert.
CAP_MB="${WAL_ARCHIVE_MAX_MB:-10240}"

STARTED="$(date -u +%FT%TZ)"
DB_URL="${POSTGRES_URL_NON_POOLING:-${POSTGRES_URL:-}}"

heartbeat() { # status, message
  [ -z "$DB_URL" ] && return 0
  "$PSQL" "$DB_URL" -v ON_ERROR_STOP=0 -q >/dev/null 2>&1 <<SQL || true
INSERT INTO pipeline_runs (pipeline, status, started_at, finished_at, items_processed, message)
VALUES ('prune-wal-cap', '$1', '${STARTED}', now(), 0,
        '$(printf '%s' "$2" | sed "s/'/''/g")');
SQL
}

wal_mb() { du -sm "$WAL_DIR" 2>/dev/null | cut -f1 | tr -dc '0-9'; }

[ -d "$WAL_DIR" ] || { echo "[prune-wal-cap] no WAL dir $WAL_DIR — nothing to do"; exit 0; }

BEFORE_MB="$(wal_mb)"; BEFORE_MB="${BEFORE_MB:-0}"

if [ "$BEFORE_MB" -le "$CAP_MB" ]; then
  echo "[prune-wal-cap] WAL archive ${BEFORE_MB}MB <= cap ${CAP_MB}MB — ok"
  heartbeat ok "WAL archive ${BEFORE_MB}MB / cap ${CAP_MB}MB"
  exit 0
fi

echo "[prune-wal-cap] OVER CAP: WAL archive ${BEFORE_MB}MB > cap ${CAP_MB}MB — pruning to newest base backup" >&2

# The NEWEST base backup: pruning to it keeps exactly one restorable timeline.
NEWEST="$(ls -1d "$BASE_DIR"/base-* 2>/dev/null | sort | tail -1)"
if [ -z "$NEWEST" ] || [ ! -f "$NEWEST/START_WAL" ]; then
  MSG="OVER CAP (${BEFORE_MB}MB > ${CAP_MB}MB) but no base backup with START_WAL — refusing to prune blindly"
  echo "[prune-wal-cap] $MSG" >&2
  heartbeat failed "$MSG"
  [ -x "$ALERT" ] && "$ALERT" wal-cap-no-base "[recrutas] WAL archive over cap, no usable base backup" - <<<"$MSG"
  exit 1
fi

CUTOFF="$(cat "$NEWEST/START_WAL")"
if [ ! -x "$PG_ARCHIVECLEANUP" ]; then
  MSG="pg_archivecleanup missing at $PG_ARCHIVECLEANUP — cannot prune"
  echo "[prune-wal-cap] $MSG" >&2
  heartbeat failed "$MSG"
  exit 1
fi

# -x .gz because archive-wal.sh stores segments compressed.
"$PG_ARCHIVECLEANUP" -x .gz "$WAL_DIR" "$CUTOFF" 2>/dev/null || true

AFTER_MB="$(wal_mb)"; AFTER_MB="${AFTER_MB:-0}"
FREED=$((BEFORE_MB - AFTER_MB))
echo "[prune-wal-cap] pruned to $CUTOFF (newest base $(basename "$NEWEST")): ${BEFORE_MB}MB -> ${AFTER_MB}MB (freed ${FREED}MB)"

if [ "$AFTER_MB" -gt "$CAP_MB" ]; then
  # One basebackup interval of WAL alone exceeds the cap. Deleting more would
  # destroy the only restorable timeline, so this is a human decision.
  MSG="WAL still ${AFTER_MB}MB > cap ${CAP_MB}MB after pruning to the newest base backup. A single backup interval now exceeds the cap — raise WAL_ARCHIVE_MAX_MB, run basebackup more often, or reduce WAL volume. NOT pruning further: that would leave WAL replayable onto no base backup we hold (= no PITR)."
  echo "[prune-wal-cap] $MSG" >&2
  heartbeat failed "$MSG"
  [ -x "$ALERT" ] && "$ALERT" wal-cap-exceeded "[recrutas] WAL archive over cap after pruning" - <<<"$MSG"
  exit 1
fi

MSG="pruned ${BEFORE_MB}MB -> ${AFTER_MB}MB (cap ${CAP_MB}MB), PITR floor now $(basename "$NEWEST")"
heartbeat warning "$MSG"
# Reaching the cap is not routine — it means growth outran the weekly prune.
[ -x "$ALERT" ] && "$ALERT" wal-cap-pruned "[recrutas] WAL archive hit space cap, pruned" - <<<"$MSG"
exit 0
