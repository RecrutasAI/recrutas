#!/usr/bin/env bash
# Postgres archive_command target.  Usage: archive-wal.sh %p %f
#
# Copies a completed WAL segment into the archive so point-in-time recovery is
# possible. Without this the recovery granularity is the nightly dump — i.e.
# corruption at 09:29 loses everything back to the previous morning.
#
# Contract with Postgres:
#   exit 0 => segment is safely archived, Postgres may recycle it
#   exit 1 => Postgres KEEPS the segment and retries
# Returning 0 without durably storing the file silently destroys recoverability,
# so the copy is written to a temp name, fsynced, then atomically renamed.
#
# NOTE: a persistently failing archive_command makes pg_wal grow without bound
# until the disk fills and the database stops. healthcheck-db.sh watches
# pg_stat_archiver for exactly that.
#
# MIGRATION TO pgBackRest/R2 (2026-08-14): the local archive below is being
# retired because keeping WAL on the same volume as PGDATA is what caused three
# disk-full incidents in nine days — and because it left PITR existing in
# exactly one place, the disk it protects.
#
# The destination is switched by a MODE FILE rather than an env var: archive_command
# inherits the postmaster's environment, so an env-var flag would need a full
# Postgres restart to change and could not be rolled back quickly. A file can be
# flipped in one line and takes effect on the very next segment.
#
#   /etc/pgbackrest/archive-mode contains one of:
#     off   — local archive only (pre-migration behaviour, and the rollback target)
#     dual  — local AND pgbackrest; BOTH must succeed. Proving phase: the local
#             archive stays authoritative, so a broken R2 path cannot silently
#             cost us recoverability — it fails loudly and Postgres retries.
#     only  — pgbackrest only. Final state; local archive stops growing.
#
# Missing/unreadable file means 'off'. Failing safe here means falling back to
# the path that has been working for weeks.
set -uo pipefail

SRC="${1:?usage: archive-wal.sh <src-path> <segment-name>}"
NAME="${2:?usage: archive-wal.sh <src-path> <segment-name>}"
DIR="${WAL_ARCHIVE_DIR:-/opt/recrutas/backups/wal}"
MODE_FILE="${ARCHIVE_MODE_FILE:-/etc/pgbackrest/archive-mode}"
MODE="$(tr -d '[:space:]' < "$MODE_FILE" 2>/dev/null || true)"
case "$MODE" in dual|only) ;; *) MODE=off ;; esac

# pgbackrest archive-push is idempotent: re-pushing an identical segment after a
# retry succeeds, and pushing a DIFFERENT segment under an existing name is
# rejected — the same "never overwrite history" contract the local copy enforces.
push_pgbackrest() {
  pgbackrest --stanza="${PGBACKREST_STANZA:-main}" archive-push "$SRC" || {
    echo "archive-wal: pgbackrest archive-push failed for $NAME" >&2
    return 1
  }
}

if [ "$MODE" = only ]; then
  push_pgbackrest || exit 1
  exit 0
fi

# Segments are a fixed 16MB and usually mostly zero-padding, so they compress
# enormously — the single biggest space saver on a 38GB disk.
# Restoring therefore needs:
#   restore_command = 'gunzip -c /opt/recrutas/backups/wal/%f.gz > %p'
# and pruning needs pg_archivecleanup -x .gz (see backup-basebackup.sh).
DEST="$DIR/$NAME.gz"

mkdir -p "$DIR" || exit 1

# Already archived: succeed only if it is byte-identical (Postgres can legitimately
# re-archive after a crash). A DIFFERENT file under the same name means something
# is badly wrong — fail loudly rather than overwrite history.
if [ -f "$DEST" ]; then
  if cmp -s <(gunzip -c "$DEST" 2>/dev/null) "$SRC"; then
    # Local copy is already good; in dual mode R2 may still be behind (e.g. the
    # previous attempt failed *after* the local write), so still push.
    [ "$MODE" = dual ] && { push_pgbackrest || exit 1; }
    exit 0
  fi
  echo "archive-wal: $NAME already archived with different contents — refusing" >&2
  exit 1
fi

TMP="$DIR/.$NAME.$$.gz"
trap 'rm -f "$TMP"' EXIT

gzip -c "$SRC" > "$TMP" || exit 1
# Durability: without fsync a crash can leave a present-but-empty segment, which
# is worse than a missing one because it looks archived.
python3 -c '
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY)
os.fsync(fd)
os.close(fd)
d = os.open(os.path.dirname(sys.argv[1]), os.O_RDONLY)
os.fsync(d)
os.close(d)
' "$TMP" 2>/dev/null || sync

mv "$TMP" "$DEST" || exit 1
trap - EXIT

# Dual mode: the segment is durable locally, now mirror it to R2. Reporting
# success to Postgres here would let it recycle a segment that never reached the
# repo, so a push failure must fail the whole command — Postgres keeps the
# segment and retries, and the local copy above makes that retry cheap.
if [ "$MODE" = dual ]; then
  push_pgbackrest || exit 1
fi

exit 0
