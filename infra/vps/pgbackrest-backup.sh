#!/usr/bin/env bash
# pgBackRest backup driver.  Usage: pgbackrest-backup.sh [full|diff|incr]
#
# Replaces backup-basebackup.sh + prune-wal-cap.sh. Both of those existed to
# keep physical backups inside a disk budget; the repo now lives in R2, where
# retention is enforced by pgbackrest itself (repo1-retention-full) and expiring
# a full backup automatically expires the WAL that only it needed. There is no
# cap to sum against the disk, which is what failed three times in nine days.
#
# Restore sketch (the whole point of all this):
#   systemctl stop postgresql@17-main
#   sudo -u postgres pgbackrest --stanza=main --delta restore
#   # ...or to a moment in time:
#   sudo -u postgres pgbackrest --stanza=main --delta \
#     --type=time --target='2026-08-14 09:15:00+00' restore
#   systemctl start postgresql@17-main
# Unlike the old tar+gunzip dance this needs no manual recovery.signal or
# restore_command — pgbackrest writes them.
#
# Runs via run-cron.sh (lock + timeout + log + failure alert).
set -uo pipefail

TYPE="${1:-incr}"
case "$TYPE" in full|diff|incr) ;; *) echo "[pgbackrest-backup] bad type '$TYPE'" >&2; exit 2 ;; esac

APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
STANZA="${PGBACKREST_STANZA:-main}"
PSQL="${PSQL_BIN:-/usr/lib/postgresql/17/bin/psql}"

cd "$APP_DIR" || { echo "[pgbackrest-backup] cannot cd $APP_DIR" >&2; exit 1; }
set -a; # shellcheck disable=SC1091
source .env; set +a

STARTED="$(date -u +%FT%TZ)"
DB_URL="${POSTGRES_URL_NON_POOLING:-${POSTGRES_URL:-}}"

heartbeat() { # status, message, bytes
  [ -z "$DB_URL" ] && return 0
  "$PSQL" "$DB_URL" -v ON_ERROR_STOP=0 -q >/dev/null 2>&1 <<SQL || true
INSERT INTO pipeline_runs (pipeline, status, started_at, finished_at, items_processed, message, stats)
VALUES ('pgbackrest-backup', '$1', '${STARTED}', now(), ${3:-0},
        '$(printf '%s' "$2" | sed "s/'/''/g")', jsonb_build_object('bytes', ${3:-0}, 'type', '${TYPE}'));
SQL
}

fail() {
  echo "[pgbackrest-backup] $1" >&2
  heartbeat error "$1"
  [ -x "$APP_DIR/infra/vps/alert.sh" ] && "$APP_DIR/infra/vps/alert.sh" "pgbackrest-backup" "$1" || true
  exit 1
}

# A backup whose WAL never reaches the repo hangs until timeout, so verify the
# archive path first and fail with a diagnosis instead of a stall.
sudo -u postgres pgbackrest --stanza="$STANZA" check \
  || fail "pgbackrest check failed — is archive-mode 'dual'/'only' and archive_command reloaded?"

echo "[pgbackrest-backup] starting $TYPE backup of stanza '$STANZA'"
sudo -u postgres pgbackrest --stanza="$STANZA" --type="$TYPE" backup \
  || fail "pgbackrest $TYPE backup failed"

# Report what the repo actually holds, not what we asked for — the difference is
# how you catch a stanza that silently stopped retaining anything.
INFO="$(sudo -u postgres pgbackrest --stanza="$STANZA" --output=json info 2>/dev/null)"
BYTES="$(printf '%s' "$INFO" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
    b = d[0]["backup"]
    print(b[-1]["info"]["repository"]["delta"] if b else 0)
except Exception:
    print(0)
' 2>/dev/null || echo 0)"
COUNT="$(printf '%s' "$INFO" | python3 -c '
import json,sys
try:
    print(len(json.load(sys.stdin)[0]["backup"]))
except Exception:
    print(0)
' 2>/dev/null || echo 0)"

MSG="$TYPE backup ok — repo holds $COUNT backup(s), this one wrote ${BYTES} bytes"
echo "[pgbackrest-backup] $MSG"
heartbeat ok "$MSG" "${BYTES:-0}"
