#!/usr/bin/env bash
# Push the local nightly dumps to OFFSITE storage, encrypted.
#
# Why: backup-vps-db.sh and backup-supabase.sh both write to /opt/recrutas/backups
# on the SAME disk as the database. Losing the VPS loses the DB and every backup
# of it. Until now the only offsite copy was the old Supabase project, which is
# a rollback artefact with a ~2-week shelf life, not a backup target.
#
# Ships both dumps, because they hold different irreplaceable things:
#   - vps-db/recrutas-db-*.sql.gz  → public schema (app data, lives on this box)
#   - db/supabase-*.sql.gz         → auth + storage (user accounts; NOT on this box)
#
# Transport is rclone, so the destination is your choice — any rclone remote
# works (Cloudflare R2, Backblaze B2, S3, Hetzner Storage Box). Dumps are
# gpg-symmetric-encrypted BEFORE upload: they contain candidate PII and the
# bucket is third-party.
#
# Config (in /opt/recrutas/app/.env):
#   OFFSITE_RCLONE_REMOTE   e.g. r2:recrutas-backups   (unset => inert, warns)
#   OFFSITE_GPG_PASSPHRASE  symmetric key — STORE IT OUTSIDE THIS BOX or the
#                           offsite copy is undecryptable exactly when needed
#   OFFSITE_RETAIN_DAYS     default 14 (~5.4GB at current dump sizes)
#
# Restore:
#   rclone copy "$OFFSITE_RCLONE_REMOTE/db/recrutas-db-<ts>.sql.gz.gpg" .
#   gpg --batch --decrypt --passphrase "$OFFSITE_GPG_PASSPHRASE" \
#       recrutas-db-<ts>.sql.gz.gpg | gunzip -c | psql "$TARGET"
#
# Runs via run-cron.sh (lock + timeout + log), same as the other jobs.
set -uo pipefail

APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
VPS_DIR="${RECRUTAS_VPS_BACKUP_DIR:-/opt/recrutas/backups/vps-db}"
SUPA_DIR="${RECRUTAS_BACKUP_DIR:-/opt/recrutas/backups/db}"
RETAIN_DAYS="${OFFSITE_RETAIN_DAYS:-14}"
PSQL="${PSQL_BIN:-/usr/lib/postgresql/17/bin/psql}"
RCLONE="${RCLONE_BIN:-/usr/bin/rclone}"

cd "$APP_DIR" || { echo "[offsite-backup] cannot cd $APP_DIR" >&2; exit 1; }
set -a; # shellcheck disable=SC1091
source .env; set +a

STARTED="$(date -u +%FT%TZ)"
DB_URL="${POSTGRES_URL_NON_POOLING:-${POSTGRES_URL:-}}"

# Heartbeat into pipeline_runs so the admin Pipeline Health panel shows whether
# an offsite copy actually happened. Best-effort: never fail the job on a write error.
heartbeat() { # status, message, bytes
  [ -z "$DB_URL" ] && return 0
  "$PSQL" "$DB_URL" -v ON_ERROR_STOP=0 -q >/dev/null 2>&1 <<SQL || true
INSERT INTO pipeline_runs (pipeline, status, started_at, finished_at, items_processed, message, stats)
VALUES ('offsite-backup', '$1', '${STARTED}', now(), ${3:-0},
        '$(printf '%s' "$2" | sed "s/'/''/g")',
        jsonb_build_object('bytes', ${3:-0}, 'retainDays', ${RETAIN_DAYS}));
SQL
}

# --- Preconditions -----------------------------------------------------------
# Unconfigured is a WARNING, not a failure: the job stays installed and keeps
# saying "no offsite copy" in the health panel until credentials are added.
if [ -z "${OFFSITE_RCLONE_REMOTE:-}" ]; then
  echo "[offsite-backup] OFFSITE_RCLONE_REMOTE not set — no offsite copy is being made" >&2
  heartbeat warning "not configured: set OFFSITE_RCLONE_REMOTE + OFFSITE_GPG_PASSPHRASE in .env"
  exit 0
fi
if [ -z "${OFFSITE_GPG_PASSPHRASE:-}" ]; then
  echo "[offsite-backup] OFFSITE_GPG_PASSPHRASE not set — refusing to upload plaintext PII" >&2
  heartbeat failed "OFFSITE_GPG_PASSPHRASE missing; refused to upload unencrypted"
  exit 1
fi
if [ ! -x "$RCLONE" ]; then
  echo "[offsite-backup] rclone not found at $RCLONE" >&2
  heartbeat failed "rclone missing at $RCLONE"
  exit 1
fi

TMP="$(mktemp -d /tmp/offsite-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

TOTAL=0
FAILED=0

# --- Encrypt + upload the newest dump from a directory -----------------------
push_latest() { # local_dir, glob, remote_subdir
  local dir="$1" glob="$2" sub="$3"
  local src enc size remote_size

  src="$(ls -1t "$dir"/$glob 2>/dev/null | head -1)"
  if [ -z "$src" ]; then
    echo "[offsite-backup] no dump matching $glob in $dir — skipping $sub" >&2
    FAILED=$((FAILED + 1))
    return
  fi

  enc="$TMP/$(basename "$src").gpg"
  if ! printf '%s' "$OFFSITE_GPG_PASSPHRASE" | gpg --batch --quiet --yes \
        --symmetric --cipher-algo AES256 --passphrase-fd 0 \
        --output "$enc" "$src"; then
    echo "[offsite-backup] gpg encrypt failed for $src" >&2
    FAILED=$((FAILED + 1))
    return
  fi

  # rclone copy verifies the transfer (size + hash where the backend supports it).
  if ! "$RCLONE" copy "$enc" "$OFFSITE_RCLONE_REMOTE/$sub/" --no-traverse 2>&1; then
    echo "[offsite-backup] upload failed for $(basename "$enc")" >&2
    FAILED=$((FAILED + 1))
    return
  fi

  # Independent read-back: confirm the object is really there at the right size.
  size="$(stat -c%s "$enc" 2>/dev/null || echo 0)"
  remote_size="$("$RCLONE" size "$OFFSITE_RCLONE_REMOTE/$sub/$(basename "$enc")" \
                  --json 2>/dev/null | grep -oE '"bytes":[0-9]+' | cut -d: -f2)"
  if [ "${remote_size:-0}" != "$size" ]; then
    echo "[offsite-backup] VERIFY FAILED $sub: local=$size remote=${remote_size:-absent}" >&2
    FAILED=$((FAILED + 1))
    return
  fi

  TOTAL=$((TOTAL + size))
  echo "[offsite-backup] $sub/$(basename "$enc") ok ($(numfmt --to=iec "$size"))"

  # Remote retention.
  "$RCLONE" delete "$OFFSITE_RCLONE_REMOTE/$sub/" --min-age "${RETAIN_DAYS}d" 2>/dev/null || true
}

push_latest "$VPS_DIR"  'recrutas-db-*.sql.gz' db
push_latest "$SUPA_DIR" 'supabase-*.sql.gz'    auth

# --- Report ------------------------------------------------------------------
HUMAN="$(numfmt --to=iec "$TOTAL" 2>/dev/null || echo "${TOTAL}B")"
if [ "$FAILED" -gt 0 ]; then
  echo "[offsite-backup] $FAILED of 2 uploads failed (pushed $HUMAN)" >&2
  heartbeat failed "$FAILED of 2 offsite uploads failed; pushed $HUMAN" "$TOTAL"
  exit 1
fi

echo "[offsite-backup] pushed $HUMAN to $OFFSITE_RCLONE_REMOTE (retain ${RETAIN_DAYS}d)"
heartbeat ok "offsite copy ok: $HUMAN, retain ${RETAIN_DAYS}d" "$TOTAL"
