#!/usr/bin/env bash
# Interactive one-time wiring of the offsite backup target. Run ON THE VPS:
#   ssh -i ~/.ssh/recrutas_cron root@178.156.193.183
#   bash /opt/recrutas/app/infra/vps/setup-offsite.sh
#
# Prompts for the bucket credentials WITHOUT ECHO and writes them straight to
# rclone.conf and .env. Nothing secret is ever passed as an argument, printed,
# or pasted into a chat transcript — which is how the AMO keys ended up needing
# rotation.
#
# Works with any S3-compatible bucket. Cloudflare R2 is the default assumption
# (10GB free tier covers ~14 days of dumps; different vendor from Hetzner, so an
# account problem cannot take out the box AND its backups together).
#
# Get the credentials first: Cloudflare dashboard -> R2 -> create a bucket, then
# "Manage R2 API Tokens" -> create an S3 API token with Object Read & Write.
set -uo pipefail

APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
ENV_FILE="$APP_DIR/.env"
RCLONE_CONF="/root/.config/rclone/rclone.conf"
REMOTE_NAME="${OFFSITE_REMOTE_NAME:-r2}"

command -v rclone >/dev/null || { echo "rclone not installed" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE" >&2; exit 1; }

echo "=== Offsite backup setup ==="
echo "Nothing you type here is echoed or logged."
echo

read -rp  "R2 account ID              : " ACCOUNT_ID
read -rsp "R2 access key ID           : " ACCESS_KEY; echo
read -rsp "R2 secret access key       : " SECRET_KEY; echo
read -rp  "Bucket name [recrutas-backups]: " BUCKET
BUCKET="${BUCKET:-recrutas-backups}"

if [ -z "$ACCOUNT_ID" ] || [ -z "$ACCESS_KEY" ] || [ -z "$SECRET_KEY" ]; then
  echo "All three credential fields are required." >&2
  exit 1
fi

mkdir -p "$(dirname "$RCLONE_CONF")"
touch "$RCLONE_CONF"; chmod 600 "$RCLONE_CONF"

if grep -q "^\[$REMOTE_NAME\]" "$RCLONE_CONF" 2>/dev/null; then
  echo "Remote [$REMOTE_NAME] already exists in $RCLONE_CONF — leaving it alone."
else
  cat >> "$RCLONE_CONF" <<EOF

[$REMOTE_NAME]
type = s3
provider = Cloudflare
access_key_id = $ACCESS_KEY
secret_access_key = $SECRET_KEY
endpoint = https://$ACCOUNT_ID.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
EOF
  echo "wrote remote [$REMOTE_NAME] to $RCLONE_CONF"
fi

echo
echo "--- testing bucket access ---"
if ! rclone lsd "$REMOTE_NAME:$BUCKET" >/dev/null 2>/tmp/offsite-test.err; then
  # An empty bucket lists fine; a genuine auth/name error does not.
  echo "could not access $REMOTE_NAME:$BUCKET" >&2
  cat /tmp/offsite-test.err >&2
  echo "Fix the credentials or bucket name and re-run." >&2
  exit 1
fi
echo "OK: $REMOTE_NAME:$BUCKET is reachable"

# --- Encryption passphrase ---------------------------------------------------
if grep -q '^OFFSITE_GPG_PASSPHRASE=' "$ENV_FILE"; then
  echo
  echo "OFFSITE_GPG_PASSPHRASE already set in .env — keeping it."
  echo "(Changing it would make existing offsite backups undecryptable.)"
else
  PASS="$(openssl rand -base64 32)"
  printf 'OFFSITE_GPG_PASSPHRASE=%s\n' "$PASS" >> "$ENV_FILE"
  echo
  echo "=============================================================="
  echo " SAVE THIS PASSPHRASE IN YOUR PASSWORD MANAGER NOW."
  echo " It is the ONLY key to the offsite backups. If it exists only"
  echo " on this box, the offsite copy is undecryptable in exactly the"
  echo " situation it was created for."
  echo
  echo "   $PASS"
  echo "=============================================================="
  echo
  read -rp "Type SAVED once it is in your password manager: " CONFIRM
  [ "$CONFIRM" = "SAVED" ] || echo "(continuing anyway — but go save it)"
fi

if grep -q '^OFFSITE_RCLONE_REMOTE=' "$ENV_FILE"; then
  sed -i "s|^OFFSITE_RCLONE_REMOTE=.*|OFFSITE_RCLONE_REMOTE=$REMOTE_NAME:$BUCKET|" "$ENV_FILE"
else
  printf 'OFFSITE_RCLONE_REMOTE=%s\n' "$REMOTE_NAME:$BUCKET" >> "$ENV_FILE"
fi
grep -q '^OFFSITE_RETAIN_DAYS=' "$ENV_FILE" || printf 'OFFSITE_RETAIN_DAYS=7\n' >> "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo
echo "--- running the first offsite push (this uploads ~400MB, a few minutes) ---"
bash "$APP_DIR/infra/vps/run-cron.sh" offsite-backup 45 \
  bash "$APP_DIR/infra/vps/offsite-backup.sh"
RC=$?

echo
if [ $RC -eq 0 ]; then
  echo "=== offsite backups are LIVE ==="
  rclone ls "$REMOTE_NAME:$BUCKET" 2>/dev/null | head -10
  echo
  echo "Runs nightly at 10:15 UTC. Failures email ADMIN_EMAILS."
else
  echo "First push FAILED (rc=$RC) — see /opt/recrutas/logs/offsite-backup.log" >&2
fi
exit $RC
