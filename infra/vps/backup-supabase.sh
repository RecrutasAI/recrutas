#!/usr/bin/env bash
# Nightly Supabase logical backup → local gzip on the VPS.
#
# Dumps the schemas that still LIVE in Supabase — auth (user accounts) and
# storage (object metadata) — as plain SQL, gzipped. Plain SQL so it restores
# anywhere, no pg_restore version coupling:
#   gunzip -c supabase-<ts>.sql.gz | psql "$TARGET_DATABASE_URL"
#
# `public` is deliberately NOT dumped any more. App data moved to the
# self-hosted VPS Postgres on 2026-07-25 (backup-vps-db.sh covers it); Supabase's
# copy has been frozen ever since — 0 new rows in 24h vs 16,600 on the VPS. We
# were re-dumping that dead 604MB nightly and keeping 7 copies of it: 1.5GB of a
# 38GB disk spent re-photographing a corpse, which contributed to the 2026-08-06
# disk-full incident. auth+storage is ~2.5MB uncompressed, so a dump is now
# sub-megabyte instead of 199MB.
#
# The frozen `public` snapshot still has value as the rollback target for the
# migration, so ONE full pre-trim dump is retained out-of-band in
# backups/db/ (supabase-20260806T090001Z.sql.gz). Do not let retention eat it
# without taking a replacement full dump first.
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
# transaction pooler (6543).
#
# After the DB migration the app's POSTGRES_URL_* point at the self-hosted VPS
# Postgres, so this backup (which must keep dumping SUPABASE for auth + the
# rollback data copy) reads a DEDICATED SUPABASE_DIRECT_URL. Falls back to the
# old vars for pre-migration environments.
URL="${SUPABASE_DIRECT_URL:-${POSTGRES_URL_NON_POOLING:-${POSTGRES_URL:-}}}"
if [ -z "$URL" ]; then
  echo "[db-backup] SUPABASE_DIRECT_URL / POSTGRES_URL_NON_POOLING not set" >&2
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
  --schema=auth --schema=storage \
  --no-owner --no-acl --quote-all-identifiers \
  2>"$ERR" | gzip > "$TMP"
rc=${PIPESTATUS[0]}

if [ "$rc" -ne 0 ]; then
  echo "[db-backup] pg_dump failed (rc=$rc) — see $ERR" >&2
  rm -f "$TMP"
  exit "$rc"
fi

# Guard against truncated / near-empty dumps. Threshold was 1MB back when this
# dumped `public` too and ran to hundreds of MB; auth+storage compresses to well
# under that, so the old floor would have failed every run.
SZ="$(stat -c%s "$TMP" 2>/dev/null || echo 0)"
if [ "$SZ" -lt 65536 ]; then
  echo "[db-backup] dump suspiciously small ($SZ bytes); keeping $TMP for inspection" >&2
  exit 1
fi

# Size alone is a weak check on a small dump, so assert the payload we actually
# care about is present: a dump that lost auth.users is worthless no matter how
# many bytes it has.
#
# grep -c, not grep -q: under `set -o pipefail`, grep -q exits on the first match
# and SIGPIPEs zcat, so the PIPELINE reports failure on a PERFECTLY GOOD dump.
# That is exactly what happened on the first run of this check. -c consumes the
# whole stream, so there is no early close to fail on.
HAS_USERS="$(zcat "$TMP" | grep -acE '^COPY "auth"\."users" ' || true)"
if [ "${HAS_USERS:-0}" -lt 1 ]; then
  echo "[db-backup] dump is missing auth.users — refusing to publish it" >&2
  mv "$TMP" "$OUT.suspect"
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
