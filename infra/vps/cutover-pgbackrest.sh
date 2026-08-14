#!/usr/bin/env bash
# Flip WAL archiving between the local disk and the R2 repo.
#   cutover-pgbackrest.sh dual   # local + R2, both must succeed (proving phase)
#   cutover-pgbackrest.sh only   # R2 only (final state)
#   cutover-pgbackrest.sh off    # local only (rollback)
#
# Deliberately a separate, tiny script: the destination of WAL is the single
# most consequential setting on this box, and it should be changeable — and
# REVERSIBLE — in one obvious command under incident pressure, not by editing a
# config and remembering which service to reload.
#
# Takes effect on the next archived segment. No Postgres restart, no reload:
# archive-wal.sh reads the mode file on every invocation.
set -uo pipefail

MODE="${1:?usage: cutover-pgbackrest.sh <dual|only|off>}"
case "$MODE" in dual|only|off) ;; *) echo "bad mode '$MODE' (want dual|only|off)" >&2; exit 2 ;; esac

MODE_FILE="${ARCHIVE_MODE_FILE:-/etc/pgbackrest/archive-mode}"
STANZA="${PGBACKREST_STANZA:-main}"
PSQL="${PSQL_BIN:-/usr/lib/postgresql/17/bin/psql}"

install -d -m 0755 "$(dirname "$MODE_FILE")"

# 0644: archive_command runs as postgres and must be able to read this.
PREV="$(tr -d '[:space:]' < "$MODE_FILE" 2>/dev/null || echo off)"
printf '%s\n' "$MODE" > "$MODE_FILE"
chmod 0644 "$MODE_FILE"
echo "[cutover] archive mode: ${PREV:-off} -> $MODE"

# Force a segment switch so the new path is exercised immediately rather than
# whenever the next segment happens to fill — with archive_timeout=3600 that
# could otherwise be an hour of false confidence.
echo "[cutover] forcing WAL switch to exercise the new path..."
sudo -u postgres "$PSQL" -X -q -c 'SELECT pg_switch_wal();' >/dev/null 2>&1 || \
  echo "[cutover] WARN: could not force a WAL switch — verify manually" >&2

sleep 5

echo "[cutover] pg_stat_archiver:"
sudo -u postgres "$PSQL" -X -c \
  'SELECT archived_count, last_archived_wal, last_archived_time, failed_count, last_failed_time FROM pg_stat_archiver;' 2>/dev/null

if [ "$MODE" != off ]; then
  echo "[cutover] pgbackrest check:"
  sudo -u postgres pgbackrest --stanza="$STANZA" check || {
    echo "[cutover] CHECK FAILED — roll back with: $0 off" >&2
    exit 1
  }
fi

echo "[cutover] ok. Rollback at any time: $0 off"
