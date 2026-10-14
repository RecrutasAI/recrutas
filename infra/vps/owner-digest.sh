#!/usr/bin/env bash
# One email a day to the owner listing the alerts that weren't urgent enough to send at once
# (see ALERT_OWNER_NOW in alert.sh). The dev agent already got each of them as it happened.
# Sends nothing on a quiet day.
#
#   bash infra/vps/owner-digest.sh
set -uo pipefail

APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
STATE_DIR="${ALERT_STATE_DIR:-/var/lib/recrutas-alerts}"
QUEUE="$STATE_DIR/owner-digest.tsv"

[ -f "$APP_DIR/.env" ] && { set -a; # shellcheck disable=SC1091
  source "$APP_DIR/.env"; set +a; }
[ -s "$QUEUE" ] || { echo "[owner-digest] nothing queued"; exit 0; }
[ -n "${RESEND_API_KEY:-}" ] && [ -n "${ADMIN_EMAILS:-}" ] || { echo "[owner-digest] RESEND_API_KEY/ADMIN_EMAILS not set" >&2; exit 1; }

# Take the queue first, so alerts arriving while this runs go into tomorrow's summary.
BATCH="$QUEUE.sending.$$"
mv "$QUEUE" "$BATCH"

PAYLOAD="$(BATCH="$BATCH" python3 - <<'PY'
import json, os, collections
rows = [l.rstrip("\n").split("\t", 2) for l in open(os.environ["BATCH"]) if l.count("\t") >= 2]
by_key = collections.OrderedDict()
for ts, key, subject in rows:
    e = by_key.setdefault(key, {"n": 0, "first": ts, "last": ts, "subject": subject})
    e["n"] += 1; e["last"] = ts; e["subject"] = subject
lines = [f"{len(rows)} alert(s) in the last day, {len(by_key)} kind(s). The dev agent (dev@recrutas.ai) got each one as it happened and handles them; nothing here needs you unless it says so.", ""]
for key, e in by_key.items():
    times = f"{e['n']}x, {e['first'][11:16]}–{e['last'][11:16]} UTC" if e["n"] > 1 else f"{e['first'][11:16]} UTC"
    lines.append(f"- {e['subject']}  ({times})")
lines += ["", "Urgent alerts (Supabase down, backups, the database, disk) still reach you at once."]
print(json.dumps({
    "from": os.environ.get("ALERT_FROM", "notifications@recrutas.ai"),
    "to": [x.strip() for x in os.environ["ADMIN_EMAILS"].split(",") if x.strip()],
    "reply_to": "dev@recrutas.ai",
    "subject": f"[recrutas] daily summary: {len(rows)} alert(s), {len(by_key)} kind(s)",
    "text": "\n".join(lines),
}))
PY
)"

CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" -H "Content-Type: application/json" -d "$PAYLOAD")"
if [ "$CODE" = "200" ]; then
  echo "[owner-digest] sent ($(wc -l <"$BATCH") line(s))"; rm -f "$BATCH"
else
  # Put the lines back so tomorrow's summary still has them.
  cat "$BATCH" >>"$QUEUE"; rm -f "$BATCH"
  echo "[owner-digest] send FAILED (http=$CODE); kept for next run" >&2; exit 1
fi
