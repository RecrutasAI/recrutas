#!/usr/bin/env bash
# Nightly Supabase logical backup → local gzip on the VPS.
#
# Dumps the irreplaceable business schemas (public = app data, auth = user
# accounts, storage = object metadata) as plain SQL, gzipped. Plain SQL so it
# restores anywhere, no pg_restore version coupling:
#   gunzip -c supabase-<ts>.sql.gz | psql "$TARGET_DATABASE_URL"
#
# This is INDEPENDENT of Supabase's own managed backups by design — its whole
# job is to survive a Supabase account lockout/deletion (the same vendor-T&S
# risk that flagged our GitHub org). Keep at least one copy OFF this VPS.
#
# Requires pg_dump 17 (server is PG17): /usr/lib/postgresql/17/bin/pg_dump
# (installed from the PGDG apt repo). Run via run-cron.sh for lock+timeout+log.
set -uo pipefail

APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
BACKUP_DIR="${RECRUTAS_BACKUP_DIR:-/opt/recrutas/backups/db}"
RETAIN_DAYS="${RECRUTAS_BACKUP_RETAIN_DAYS:-7}"
PG_DUMP="${PG_DUMP_BIN:-/usr/lib/postgresql/17/bin/pg_dump}"

cd "$APP_DIR" || { echo "[db-backup] cannot cd $APP_DIR" >&2; exit 1; }
set -a; # shellcheck disable=SC1091
source .env; set +a

# Use the direct/session connection (port 5432). pg_dump cannot run through the
# transaction pooler (6543). POSTGRES_URL_NON_POOLING is the session-mode URL.
URL="${POSTGRES_URL_NON_POOLING:-${POSTGRES_URL:-}}"
if [ -z "$URL" ]; then
  echo "[db-backup] POSTGRES_URL_NON_POOLING / POSTGRES_URL not set" >&2
  exit 1
fi

if [ ! -x "$PG_DUMP" ]; then
  echo "[db-backup] pg_dump 17 not found at $PG_DUMP" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/supabase-$TS.sql.gz"
TMP="$OUT.partial"
ERR="$BACKUP_DIR/last-error.log"

# Atomic: write to .partial, validate, then rename.
"$PG_DUMP" "$URL" \
  --schema=public --schema=auth --schema=storage \
  --no-owner --no-acl --quote-all-identifiers \
  2>"$ERR" | gzip > "$TMP"
rc=${PIPESTATUS[0]}

if [ "$rc" -ne 0 ]; then
  echo "[db-backup] pg_dump failed (rc=$rc) — see $ERR" >&2
  rm -f "$TMP"
  exit "$rc"
fi

# Guard against truncated / near-empty dumps (real dump is hundreds of MB).
SZ="$(stat -c%s "$TMP" 2>/dev/null || echo 0)"
if [ "$SZ" -lt 1048576 ]; then
  echo "[db-backup] dump suspiciously small ($SZ bytes); keeping $TMP for inspection" >&2
  exit 1
fi

# Integrity: gzip must decompress cleanly.
if ! gzip -t "$TMP"; then
  echo "[db-backup] gzip integrity check failed" >&2
  mv "$TMP" "$OUT.corrupt"
  exit 1
fi

mv "$TMP" "$OUT"
echo "[db-backup] wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Retention: drop dumps older than RETAIN_DAYS.
find "$BACKUP_DIR" -name 'supabase-*.sql.gz' -type f -mtime +"$RETAIN_DAYS" -delete
echo "[db-backup] kept $(ls -1 "$BACKUP_DIR"/supabase-*.sql.gz 2>/dev/null | wc -l) dump(s) in $BACKUP_DIR"
