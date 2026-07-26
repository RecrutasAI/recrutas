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
set -uo pipefail

SRC="${1:?usage: archive-wal.sh <src-path> <segment-name>}"
NAME="${2:?usage: archive-wal.sh <src-path> <segment-name>}"
DIR="${WAL_ARCHIVE_DIR:-/opt/recrutas/backups/wal}"

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
exit 0
