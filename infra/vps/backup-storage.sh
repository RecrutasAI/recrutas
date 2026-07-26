#!/usr/bin/env bash
# Nightly backup of the Supabase Storage OBJECTS (résumé files).
#
# Why this exists: backup-supabase.sh dumps the `storage` SCHEMA, which is only
# object METADATA — rows describing files. It does not contain a single byte of
# any actual résumé. Until this script, losing the Supabase Storage bucket meant
# every résumé was gone permanently while the database kept happily pointing at
# dead URLs. That is unrecoverable data loss from a full "we have backups" state.
#
# Downloads the whole bucket (currently ~492 objects / 53MB — small enough that
# a full nightly copy beats the complexity of incremental sync), verifies the
# byte count against the DB's own metadata, and tars it. offsite-backup.sh then
# ships the tarball off the box.
#
# Restore:
#   tar xzf resumes-<ts>.tar.gz
#   # re-upload with the Storage API, or point a bucket at the extracted tree
#
# Runs via run-cron.sh (lock + timeout + log), same as the other jobs.
set -uo pipefail

APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
BACKUP_DIR="${RECRUTAS_STORAGE_BACKUP_DIR:-/opt/recrutas/backups/storage}"
RETAIN_DAYS="${RECRUTAS_BACKUP_RETAIN_DAYS:-7}"
BUCKET="${STORAGE_BACKUP_BUCKET:-resumes}"
PARALLEL="${STORAGE_BACKUP_PARALLEL:-4}"
PSQL="${PSQL_BIN:-/usr/lib/postgresql/17/bin/psql}"

cd "$APP_DIR" || { echo "[storage-backup] cannot cd $APP_DIR" >&2; exit 1; }
set -a; # shellcheck disable=SC1091
source .env; set +a

STARTED="$(date -u +%FT%TZ)"
DB_URL="${POSTGRES_URL_NON_POOLING:-${POSTGRES_URL:-}}"

heartbeat() { # status, message, count
  [ -z "$DB_URL" ] && return 0
  "$PSQL" "$DB_URL" -v ON_ERROR_STOP=0 -q >/dev/null 2>&1 <<SQL || true
INSERT INTO pipeline_runs (pipeline, status, started_at, finished_at, items_processed, message, stats)
VALUES ('storage-backup', '$1', '${STARTED}', now(), ${3:-0},
        '$(printf '%s' "$2" | sed "s/'/''/g")',
        jsonb_build_object('objects', ${3:-0}, 'bucket', '${BUCKET}'));
SQL
}

for v in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_DIRECT_URL; do
  if [ -z "${!v:-}" ]; then
    echo "[storage-backup] $v not set" >&2
    heartbeat failed "$v missing"
    exit 1
  fi
done

TMP="$(mktemp -d /tmp/storage-backup-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
STAGE="$TMP/$BUCKET"
mkdir -p "$STAGE"

# --- Manifest straight from Supabase's own metadata --------------------------
# Tab-separated: name <TAB> size. This is also the expectation we verify against.
if ! "$PSQL" "$SUPABASE_DIRECT_URL" -tA -F $'\t' -c \
      "SELECT name, COALESCE((metadata->>'size')::bigint, 0)
       FROM storage.objects WHERE bucket_id = '${BUCKET}' ORDER BY name" \
      > "$TMP/manifest.tsv" 2>"$TMP/psql.err"; then
  echo "[storage-backup] could not list objects: $(cat "$TMP/psql.err")" >&2
  heartbeat failed "listing objects failed"
  exit 1
fi

EXPECTED_N="$(wc -l < "$TMP/manifest.tsv" | tr -d ' ')"
EXPECTED_B="$(awk -F'\t' '{s+=$2} END{print s+0}' "$TMP/manifest.tsv")"
if [ "$EXPECTED_N" -eq 0 ]; then
  echo "[storage-backup] bucket '$BUCKET' reports 0 objects — refusing to write an empty backup" >&2
  heartbeat failed "bucket $BUCKET listed 0 objects"
  exit 1
fi
echo "[storage-backup] $EXPECTED_N objects, $(numfmt --to=iec "$EXPECTED_B") expected"

# --- Download ----------------------------------------------------------------
# Object names can contain characters that need percent-encoding in a URL, so
# build the URL/destination pairs in python rather than guessing in shell.
python3 - "$TMP/manifest.tsv" "$STAGE" > "$TMP/jobs.tsv" <<'PY'
import sys, urllib.parse, os
manifest, stage = sys.argv[1], sys.argv[2]
with open(manifest, encoding='utf-8') as fh:
    for line in fh:
        line = line.rstrip('\n')
        if not line:
            continue
        name = line.split('\t')[0]
        dest = os.path.join(stage, name)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        print(f"{urllib.parse.quote(name)}\t{dest}")
PY

export SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY BUCKET
# shellcheck disable=SC2016
tr '\t' '\n' < "$TMP/jobs.tsv" | xargs -P "$PARALLEL" -n 2 sh -c '
  curl -sS --fail --retry 3 --retry-delay 2 --max-time 120 \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -o "$2" "$SUPABASE_URL/storage/v1/object/$BUCKET/$1" \
    || { echo "[storage-backup] FAILED $1" >&2; exit 0; }
' _

# --- Verify against the manifest before trusting the tarball -----------------
ACTUAL_N="$(find "$STAGE" -type f | wc -l | tr -d ' ')"
ACTUAL_B="$(find "$STAGE" -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}')"
echo "[storage-backup] downloaded $ACTUAL_N/$EXPECTED_N objects, $(numfmt --to=iec "$ACTUAL_B")"

if [ "$ACTUAL_N" -ne "$EXPECTED_N" ] || [ "$ACTUAL_B" -ne "$EXPECTED_B" ]; then
  echo "[storage-backup] MISMATCH vs Supabase metadata (expected $EXPECTED_N/$EXPECTED_B bytes)" >&2
  # A partial copy is still worth keeping — but say so loudly and mark it.
  SUFFIX=".partial"
  STATUS=warning
  MSG="partial: $ACTUAL_N/$EXPECTED_N objects, $(numfmt --to=iec "$ACTUAL_B")/$(numfmt --to=iec "$EXPECTED_B")"
else
  SUFFIX=""
  STATUS=ok
  MSG="$ACTUAL_N objects, $(numfmt --to=iec "$ACTUAL_B")"
fi

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/${BUCKET}-${TS}.tar.gz${SUFFIX}"
if ! tar -czf "$OUT" -C "$TMP" "$BUCKET"; then
  echo "[storage-backup] tar failed" >&2
  heartbeat failed "tar failed" "$ACTUAL_N"
  exit 1
fi

echo "[storage-backup] wrote $OUT ($(du -h "$OUT" | cut -f1))"
find "$BACKUP_DIR" -name "${BUCKET}-*.tar.gz*" -type f -mtime +"$RETAIN_DAYS" -delete
heartbeat "$STATUS" "$MSG" "$ACTUAL_N"
[ "$STATUS" = ok ] || exit 1
