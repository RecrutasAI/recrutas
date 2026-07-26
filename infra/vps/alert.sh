#!/usr/bin/env bash
# Send an operational alert by email, via the Resend key the app already uses.
#
#   alert.sh <dedupe-key> <subject> [body-file-or-"-"]
#
# Deliberately no new vendor: RESEND_API_KEY and ADMIN_EMAILS are already in
# .env, and recrutas.ai is already a verified Resend sending domain.
#
# Rate-limited per dedupe-key so a check that runs every 15 minutes and keeps
# failing sends one mail every ALERT_COOLDOWN_SEC (default 6h) instead of 96 a
# day — an alert channel that floods gets muted, and a muted channel is the same
# as no channel.
#
# ALWAYS exits 0. Alerting must never be the reason a backup or health check is
# recorded as failed.
set -uo pipefail

APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
STATE_DIR="${ALERT_STATE_DIR:-/var/lib/recrutas-alerts}"
COOLDOWN="${ALERT_COOLDOWN_SEC:-21600}" # 6h

KEY="${1:-unknown}"
SUBJECT="${2:-[recrutas] alert}"
BODY_SRC="${3:-}"

[ -f "$APP_DIR/.env" ] && { set -a; # shellcheck disable=SC1091
  source "$APP_DIR/.env"; set +a; }

if [ -z "${RESEND_API_KEY:-}" ] || [ -z "${ADMIN_EMAILS:-}" ]; then
  echo "[alert] RESEND_API_KEY/ADMIN_EMAILS not set — cannot alert: $SUBJECT" >&2
  exit 0
fi

mkdir -p "$STATE_DIR" 2>/dev/null
STAMP="$STATE_DIR/$(printf '%s' "$KEY" | tr -c '[:alnum:]._-' '_')"

# Rate limit
if [ -f "$STAMP" ]; then
  LAST="$(stat -c %Y "$STAMP" 2>/dev/null || echo 0)"
  AGE=$(( $(date +%s) - LAST ))
  if [ "$AGE" -lt "$COOLDOWN" ]; then
    echo "[alert] suppressed '$KEY' (last sent ${AGE}s ago, cooldown ${COOLDOWN}s)"
    exit 0
  fi
fi

# Body: a file, "-" for stdin, else empty.
BODY=""
if [ "$BODY_SRC" = "-" ]; then
  BODY="$(cat)"
elif [ -n "$BODY_SRC" ] && [ -f "$BODY_SRC" ]; then
  BODY="$(tail -c 8000 "$BODY_SRC")"
fi

HOST="$(hostname -f 2>/dev/null || hostname)"
FULL="host: $HOST
time: $(date -u +%FT%TZ)
key:  $KEY

$BODY"

# JSON-encode with python so log output containing quotes/newlines can't break
# the request (and so a malformed body can't silently drop the alert).
PAYLOAD="$(SUBJECT="$SUBJECT" FULL="$FULL" TO="$ADMIN_EMAILS" python3 -c '
import json, os
to = [e.strip() for e in os.environ["TO"].split(",") if e.strip()]
print(json.dumps({
    "from": os.environ.get("ALERT_FROM", "notifications@recrutas.ai"),
    "to": to,
    "subject": os.environ["SUBJECT"],
    "text": os.environ["FULL"],
}))
')"

CODE="$(curl -sS -o /tmp/alert-resp.$$ -w '%{http_code}' --max-time 20 \
  -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>/dev/null)"

if [ "$CODE" = "200" ]; then
  touch "$STAMP"
  echo "[alert] sent '$KEY' to $ADMIN_EMAILS"
else
  echo "[alert] send FAILED (http=$CODE): $(cat /tmp/alert-resp.$$ 2>/dev/null)" >&2
fi
rm -f /tmp/alert-resp.$$
exit 0
