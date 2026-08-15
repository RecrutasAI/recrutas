#!/usr/bin/env bash
# Nightly logical backup of the SELF-HOSTED VPS Postgres (post-migration) → local gzip.
#
# After the Supabase→VPS DB migration, the app's business data lives in the
# local Postgres on this box. This backs it up independently of everything
# else. Plain SQL so it restores anywhere:
#   gunzip -c recrutas-db-<ts>.sql.gz | psql "$TARGET"
#
# Offsite: LIVE since 2026-07. offsite-backup.sh (cron 10:15) GPG-encrypts the
# newest dump here and pushes it to R2 on a 7-day window, so this directory is
# the fast-restore copy and R2 is the deep one. That is why RETAIN_DAYS below
# is 2 — if you ever disable the offsite push, raise it back first.
#
# Runs via run-cron.sh (lock + timeout + log), same as the other jobs.
set -uo pipefail

BACKUP_DIR="${RECRUTAS_VPS_BACKUP_DIR:-/opt/recrutas/backups/vps-db}"
# Own retention knob, deliberately NOT the shared RECRUTAS_BACKUP_RETAIN_DAYS
# that backup-supabase.sh and backup-storage.sh use. Those two produce 194MB and
# 450MB total; this one produces ~1.3GB PER DAY and grew 36% in the week to
# 2026-08-14 (959MB → 1.3GB) as the job table grew. It is the only one of the
# three whose retention is a disk-capacity decision, so it gets its own dial —
# turning the shared one down to protect this disk would also throw away auth
# and résumé history that costs almost nothing to keep.
#
# 2, not 7, because offsite-backup.sh pushes the newest dump to R2 nightly on a
# 7-day window (verified 2026-08-14: all 7 local dumps had a .gpg counterpart
# there). Seven local copies were 7.5GB duplicating a window R2 already holds —
# on the same volume Postgres runs on, which filled three times in nine days.
# Local copies exist for a FAST restore, not for depth; depth lives offsite.
#
# Raising this is a disk decision: budget ~1.3GB per day and growing.
# No chained fallback to the shared var on purpose — one dial, one meaning.
RETAIN_DAYS="${RECRUTAS_VPS_DB_RETAIN_DAYS:-2}"
PG_DUMP="${PG_DUMP_BIN:-/usr/lib/postgresql/17/bin/pg_dump}"
# Local session connection to the self-hosted DB. Defaults to the app role over
# localhost; override with VPS_DB_DUMP_URL if credentials differ.
DB_NAME="${PG_APP_DB:-recrutas}"
DB_ROLE="${PG_APP_ROLE:-recrutas_app}"

# Prefer an explicit dump URL; else read the app's own connection string.
URL="${VPS_DB_DUMP_URL:-}"
if [ -z "$URL" ]; then
  APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
  if [ -f "$APP_DIR/.env" ]; then
    set -a; # shellcheck disable=SC1091
    source "$APP_DIR/.env"; set +a
    URL="${POSTGRES_URL_NON_POOLING:-${POSTGRES_URL:-}}"
  fi
fi
if [ -z "$URL" ]; then
  echo "[vps-db-backup] no connection URL (set VPS_DB_DUMP_URL or POSTGRES_URL_NON_POOLING)" >&2
  exit 1
fi

# Heartbeat into pipeline_runs so the admin Pipeline Health panel can tell that
# this backup actually ran. Without it the job was invisible there: a silent
# stop looked identical to a healthy history, because a row that never appears
# can never go stale. Best-effort — a heartbeat write must never fail the backup.
PSQL="${PSQL_BIN:-/usr/lib/postgresql/17/bin/psql}"
STARTED="$(date -u +%FT%TZ)"
heartbeat() { # status, message, bytes
  [ -z "$URL" ] && return 0
  "$PSQL" "$URL" -v ON_ERROR_STOP=0 -q >/dev/null 2>&1 <<SQL || true
INSERT INTO pipeline_runs (pipeline, status, started_at, finished_at, items_processed, message, stats)
VALUES ('vps-db-backup', '$1', '${STARTED}', now(), ${3:-0},
        '$(printf '%s' "$2" | sed "s/'/''/g")',
        jsonb_build_object('bytes', ${3:-0}, 'retainDays', ${RETAIN_DAYS}));
SQL
}

if [ ! -x "$PG_DUMP" ]; then
  echo "[vps-db-backup] pg_dump 17 not found at $PG_DUMP" >&2
  heartbeat failed "pg_dump 17 not found at $PG_DUMP"
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/recrutas-db-$TS.sql.gz"
TMP="$OUT.partial"
ERR="$BACKUP_DIR/last-error.log"

# Atomic: write to .partial, validate, then rename. public schema only —
# auth/storage remain on Supabase.
"$PG_DUMP" "$URL" \
  --schema=public --no-owner --no-acl --quote-all-identifiers \
  2>"$ERR" | gzip > "$TMP"
rc=${PIPESTATUS[0]}

if [ "$rc" -ne 0 ]; then
  echo "[vps-db-backup] pg_dump failed (rc=$rc) — see $ERR" >&2
  heartbeat failed "pg_dump failed (rc=$rc); see $ERR"
  rm -f "$TMP"
  exit "$rc"
fi

# Guard against truncated / near-empty dumps (real dump is >100MB).
SZ="$(stat -c%s "$TMP" 2>/dev/null || echo 0)"
if [ "$SZ" -lt 1048576 ]; then
  echo "[vps-db-backup] dump suspiciously small ($SZ bytes); keeping $TMP for inspection" >&2
  heartbeat failed "dump suspiciously small ($SZ bytes) — kept as .partial for inspection" "$SZ"
  exit 1
fi

# Integrity: gzip must decompress cleanly.
if ! gzip -t "$TMP"; then
  echo "[vps-db-backup] gzip integrity check failed" >&2
  heartbeat failed "gzip integrity check failed — kept as .corrupt" "$SZ"
  mv "$TMP" "$OUT.corrupt"
  exit 1
fi

mv "$TMP" "$OUT"
echo "[vps-db-backup] wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Retention: keep RETAIN_DAYS daily dumps. `-mtime +N` matches files strictly
# older than N+1 days, so +RETAIN_DAYS actually kept RETAIN_DAYS+1 dumps —
# with ~1.2GB dumps that eighth file was a real bite out of the disk budget.
find "$BACKUP_DIR" -name 'recrutas-db-*.sql.gz' -type f -mtime +"$((RETAIN_DAYS - 1))" -delete
KEPT="$(ls -1 "$BACKUP_DIR"/recrutas-db-*.sql.gz 2>/dev/null | wc -l)"
echo "[vps-db-backup] kept $KEPT dump(s) in $BACKUP_DIR"
heartbeat ok "dump $(du -h "$OUT" | cut -f1), $KEPT kept, retain ${RETAIN_DAYS}d" "$SZ"
