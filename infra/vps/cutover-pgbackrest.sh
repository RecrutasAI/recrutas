#!/usr/bin/env bash
# Switch WAL archiving between the local disk archive and the pgBackRest R2 repo.
#   cutover-pgbackrest.sh on    # archive_command -> pgbackrest archive-push
#   cutover-pgbackrest.sh off   # archive_command -> archive-wal.sh  (rollback)
#
# Deliberately a separate, tiny script: the destination of WAL is the single most
# consequential setting on this box, and it should be changeable — and REVERSIBLE
# — in one obvious command under incident pressure.
#
# WHY NOT DUAL-WRITE: the first attempt wrapped both destinations in one script so
# the local copy could stay authoritative while R2 was proven. pgBackRest refuses
# that outright — 'archive_command must contain pgbackrest' (error 068) — and it
# is right to. Defeating that check (a '# pgbackrest' comment in the command) buys
# a belt-and-braces window at the cost of running an unsupported configuration
# whose failure modes nobody upstream has debugged, on the one path where being
# wrong silently costs recoverability.
#
# The exposure that dual-write would have covered is small and bounded anyway:
# the existing local archive is FROZEN, not deleted, so the pre-cutover PITR chain
# (base-20260813 + WAL up to this moment) stays intact and usable on disk until
# the first pgBackRest full backup is verified. Retire it only after that.
#
# archive_command is SIGHUP-scoped, so this is a reload, never a restart.
set -uo pipefail

MODE="${1:?usage: cutover-pgbackrest.sh <on|off>}"
case "$MODE" in on|off) ;; *) echo "bad mode '$MODE' (want on|off)" >&2; exit 2 ;; esac

APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
STANZA="${PGBACKREST_STANZA:-main}"
CONF="${ARCHIVE_CONF:-/etc/postgresql/17/main/conf.d/35-recrutas-archive.conf}"
UNIT="${PG_UNIT:-postgresql@17-main}"
PSQL="${PSQL_BIN:-/usr/lib/postgresql/17/bin/psql}"

[ -f "$CONF" ] || { echo "[cutover] missing $CONF" >&2; exit 1; }

if [ "$MODE" = on ]; then
  NEW="pgbackrest --stanza=${STANZA} archive-push %p"
else
  NEW="${APP_DIR}/infra/vps/archive-wal.sh %p %f"
fi

cp -a "$CONF" "${CONF}.bak-$(date -u +%Y%m%dT%H%M%SZ)"

# Rewrite only the archive_command line, leaving archive_mode/timeout alone.
python3 - "$CONF" "$NEW" <<'PY'
import re, sys
path, new = sys.argv[1], sys.argv[2]
src = open(path).read()
line = "archive_command = '%s'" % new
out, n = re.subn(r"(?m)^\s*archive_command\s*=.*$", line.replace("\\", "\\\\"), src)
if n == 0:
    out = src.rstrip("\n") + "\n" + line + "\n"
open(path, "w").write(out)
PY

echo "[cutover] archive_command -> $NEW"
systemctl reload "$UNIT" || { echo "[cutover] reload failed" >&2; exit 1; }
sleep 2

# Confirm the running server actually took it. A reload that silently no-ops
# would leave WAL going to the old place while everything below reports success.
LIVE="$(sudo -u postgres "$PSQL" -X -q -t -A -c 'SHOW archive_command;' 2>/dev/null)"
echo "[cutover] live archive_command: $LIVE"
case "$LIVE" in
  *"$( [ "$MODE" = on ] && echo pgbackrest || echo archive-wal.sh )"*) ;;
  *) echo "[cutover] FAILED: server did not pick up the new archive_command" >&2; exit 1 ;;
esac

FAILED_BEFORE="$(sudo -u postgres "$PSQL" -X -q -t -A -c 'SELECT failed_count FROM pg_stat_archiver;' 2>/dev/null)"

# Force a segment switch so the new path is exercised now rather than whenever the
# next segment happens to fill — with archive_timeout=3600 that could otherwise be
# an hour of false confidence.
echo "[cutover] forcing WAL switch..."
sudo -u postgres "$PSQL" -X -q -c 'SELECT pg_switch_wal();' >/dev/null 2>&1 \
  || echo "[cutover] WARN: could not force a WAL switch" >&2
sleep 8

sudo -u postgres "$PSQL" -X -c \
  'SELECT archived_count, last_archived_wal, last_archived_time, failed_count, last_failed_time FROM pg_stat_archiver;' 2>/dev/null

FAILED_AFTER="$(sudo -u postgres "$PSQL" -X -q -t -A -c 'SELECT failed_count FROM pg_stat_archiver;' 2>/dev/null)"
if [ -n "$FAILED_BEFORE" ] && [ -n "$FAILED_AFTER" ] && [ "$FAILED_AFTER" -gt "$FAILED_BEFORE" ]; then
  echo "[cutover] FAILED: archiver failure count rose ${FAILED_BEFORE} -> ${FAILED_AFTER}" >&2
  echo "[cutover] roll back with: $0 off" >&2
  exit 1
fi

if [ "$MODE" = on ]; then
  echo "[cutover] pgbackrest check:"
  sudo -u postgres pgbackrest --stanza="$STANZA" check || {
    echo "[cutover] CHECK FAILED — roll back with: $0 off" >&2
    exit 1
  }
fi

echo "[cutover] ok (mode=$MODE). Rollback at any time: $0 off"
