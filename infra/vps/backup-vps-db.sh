#!/usr/bin/env bash
# Nightly logical backup of the SELF-HOSTED VPS Postgres (post-migration) → local gzip.
#
# After the Supabase→VPS DB migration, the app's business data lives in the
# local Postgres on this box. This backs it up independently of everything
# else. Plain SQL so it restores anywhere:
#   gunzip -c recrutas-db-<ts>.sql.gz | psql "$TARGET"
#
# Offsite: while the old Supabase project is kept as a rollback (>=2 weeks
# post-cutover), Supabase itself is a second copy of this data. A dedicated
# offsite target (B2 / recrutas-dev storage) should be wired before that
# window closes — see infra/vps/README.md.
#
# Runs via run-cron.sh (lock + timeout + log), same as the other jobs.
set -uo pipefail

BACKUP_DIR="${RECRUTAS_VPS_BACKUP_DIR:-/opt/recrutas/backups/vps-db}"
RETAIN_DAYS="${RECRUTAS_BACKUP_RETAIN_DAYS:-7}"
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

if [ ! -x "$PG_DUMP" ]; then
  echo "[vps-db-backup] pg_dump 17 not found at $PG_DUMP" >&2
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
  rm -f "$TMP"
  exit "$rc"
fi

# Guard against truncated / near-empty dumps (real dump is >100MB).
SZ="$(stat -c%s "$TMP" 2>/dev/null || echo 0)"
if [ "$SZ" -lt 1048576 ]; then
  echo "[vps-db-backup] dump suspiciously small ($SZ bytes); keeping $TMP for inspection" >&2
  exit 1
fi

# Integrity: gzip must decompress cleanly.
if ! gzip -t "$TMP"; then
  echo "[vps-db-backup] gzip integrity check failed" >&2
  mv "$TMP" "$OUT.corrupt"
  exit 1
fi

mv "$TMP" "$OUT"
echo "[vps-db-backup] wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Retention: keep RETAIN_DAYS daily dumps. `-mtime +N` matches files strictly
# older than N+1 days, so +RETAIN_DAYS actually kept RETAIN_DAYS+1 dumps —
# with ~1.2GB dumps that eighth file was a real bite out of the disk budget.
find "$BACKUP_DIR" -name 'recrutas-db-*.sql.gz' -type f -mtime +"$((RETAIN_DAYS - 1))" -delete
echo "[vps-db-backup] kept $(ls -1 "$BACKUP_DIR"/recrutas-db-*.sql.gz 2>/dev/null | wc -l) dump(s) in $BACKUP_DIR"
