#!/usr/bin/env bash
# Send an operational alert by email (Resend) and, if NTFY_TOPIC is set, as a phone push
# through ntfy.sh, so a Resend outage can't hide every other outage.
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

if { [ -z "${RESEND_API_KEY:-}" ] || [ -z "${ADMIN_EMAILS:-}" ]; } && [ -z "${NTFY_TOPIC:-}" ]; then
  echo "[alert] no channel set (RESEND_API_KEY+ADMIN_EMAILS or NTFY_TOPIC) — cannot alert: $SUBJECT" >&2
  exit 0
fi

# Recipients: ADMIN_EMAILS (the owner), plus the agent that fixes it (Abas, 2026-10-13: "send
# these cron failed emails to dev; if anything is gtm related, send it to gtm"). ALERT_ALSO_TO
# (default dev@recrutas.ai) gets every alert; keys in ALERT_GTM_KEYS (default the GTM report
# job) also go to ALERT_GTM_TO (gtm@recrutas.ai).
TO="${ADMIN_EMAILS:-},${ALERT_ALSO_TO:-dev@recrutas.ai}"
for k in ${ALERT_GTM_KEYS:-cron-weekly-numbers}; do
  [ "$KEY" = "$k" ] && TO="$TO,${ALERT_GTM_TO:-gtm@recrutas.ai}"
done

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
PAYLOAD="$(SUBJECT="$SUBJECT" FULL="$FULL" TO="$TO" python3 -c '
import json, os
to = [e.strip() for e in os.environ["TO"].split(",") if e.strip()]
print(json.dumps({
    "from": os.environ.get("ALERT_FROM", "notifications@recrutas.ai"),
    "to": to,
    "subject": os.environ["SUBJECT"],
    "text": os.environ["FULL"],
}))
')"

SENT=0
if [ -n "${RESEND_API_KEY:-}" ] && [ -n "${ADMIN_EMAILS:-}" ]; then
  CODE="$(curl -sS -o /tmp/alert-resp.$$ -w '%{http_code}' --max-time 20 \
    -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $RESEND_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>/dev/null)"
  if [ "$CODE" = "200" ]; then
    SENT=1
    echo "[alert] sent '$KEY' to $TO"
  else
    echo "[alert] email FAILED (http=$CODE): $(cat /tmp/alert-resp.$$ 2>/dev/null)" >&2
  fi
  rm -f /tmp/alert-resp.$$
fi

# Second channel, independent of Resend: a phone push through ntfy.sh (free app,
# subscribe to the NTFY_TOPIC channel). Subject only: ntfy's public server is open to
# anyone who knows the channel name, so log text and details stay in the email/VPS logs.
if [ -n "${NTFY_TOPIC:-}" ]; then
  NCODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    -H "Title: $(printf '%s' "$SUBJECT" | tr -d '\r\n' | cut -c1-200)" \
    -H "Tags: rotating_light" \
    -d "Details in the alert email or on the VPS (alert key: $KEY)." \
    "https://ntfy.sh/$NTFY_TOPIC" 2>/dev/null)"
  if [ "$NCODE" = "200" ]; then SENT=1; echo "[alert] pushed '$KEY' to ntfy"; else echo "[alert] ntfy push FAILED (http=$NCODE)" >&2; fi
fi

# Rate-limit only after at least one channel delivered, so a failed send retries.
[ "$SENT" = "1" ] && touch "$STAMP"
exit 0
