#!/usr/bin/env bash
# Keep asking Oracle for the Always Free A1 server (2 OCPU / 12 GB, home region San Jose)
# until it lands. Free capacity there is scarce, so this is patient by design:
#   - "Out of host capacity" (provision.sh exit 2) and "Too many requests" (HTTP 429) or
#     Oracle 5xx answers are normal: wait and try again, slower after a 429.
#   - Anything else is a real error: alert, wait an hour, try again (a fix may land meanwhile).
#   - Success: alert (email + phone push via infra/vps/alert.sh) and stop.
# Runs as the systemd service oracle-a1-retry (infra/oracle/oracle-a1-retry.service).
set -uo pipefail
export PATH=/opt/oci-cli/bin:$PATH OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING=True SUPPRESS_LABEL_WARNING=True
export SSH_KEYS="${SSH_KEYS:-/root/.ssh/oracle_llm.pub /opt/recrutas/oracle/admin.pub}"
DIR="${ORACLE_DIR:-/opt/recrutas/oracle}"
ALERT=/opt/recrutas/app/infra/vps/alert.sh
BASE_WAIT=600          # 10 min between normal attempts
SLOW_WAIT=1800         # 30 min after Oracle says "too many requests"
ERROR_WAIT=3600        # 1 h after an unexpected error

attempt=0
while true; do
  attempt=$((attempt + 1))
  out=$(timeout 900 "$DIR/provision.sh" 2>&1); rc=$?
  ts=$(date -u +%FT%H:%MZ)
  if [ $rc -eq 0 ]; then
    echo "$ts attempt $attempt: LAUNCHED"; echo "$out" | tail -3
    printf "The Oracle A1 server launched on attempt %s (%s).\n\n%s\n" "$attempt" "$ts" "$(echo "$out" | tail -3)" \
      | bash "$ALERT" oracle-a1-launched "[recrutas] Oracle A1 server is up" -
    exit 0
  fi
  if [ $rc -eq 2 ] || echo "$out" | grep -qiE 'out of host capacity|OutOfCapacity'; then
    echo "$ts attempt $attempt: no capacity"; wait=$BASE_WAIT
  elif echo "$out" | grep -qE '"status": (429|5[0-9][0-9])|TooManyRequests|InternalError'; then
    echo "$ts attempt $attempt: Oracle busy ($(echo "$out" | grep -oE '"code": "[A-Za-z]+"' | head -1))"; wait=$SLOW_WAIT
  else
    echo "$ts attempt $attempt: ERROR rc=$rc"; echo "$out" | tail -15
    echo "$out" | tail -30 | bash "$ALERT" oracle-a1-error "[recrutas] Oracle A1 retry hit an unexpected error (still retrying hourly)" -
    wait=$ERROR_WAIT
  fi
  # Spread attempts a little so they don't land on the same second as everyone else's.
  sleep $((wait + RANDOM % 120))
done
