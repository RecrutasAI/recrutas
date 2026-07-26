#!/usr/bin/env bash
# Cron wrapper for the VPS — mirrors the GitHub Actions cron workflows:
# per-job lock (concurrency group), per-job timeout, logging, .env loading.
#
# Usage: run-cron.sh <job-name> <timeout-minutes> <command...>
set -uo pipefail

APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
LOG_DIR="${RECRUTAS_LOG_DIR:-/opt/recrutas/logs}"

JOB="$1"; shift
TIMEOUT_MIN="$1"; shift

mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$JOB.log"

# GHA used cancel-in-progress; here we skip the new run instead, which is
# safer for scrapers mid-write.
exec 9>"/tmp/recrutas-cron-$JOB.lock"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) [$JOB] previous run still active, skipping" >>"$LOG"
  exit 0
fi

cd "$APP_DIR"
set -a
# shellcheck disable=SC1091
source .env
set +a

echo "=== $(date -u +%FT%TZ) [$JOB] start ===" >>"$LOG"
timeout "${TIMEOUT_MIN}m" "$@" >>"$LOG" 2>&1
rc=$?
[ $rc -eq 124 ] && echo "[$JOB] KILLED after ${TIMEOUT_MIN}m timeout" >>"$LOG"
echo "=== $(date -u +%FT%TZ) [$JOB] exit $rc ===" >>"$LOG"

# Alert on failure. Hooked here rather than in each script so every job — the
# health check, all three backups, every scraper — is covered by one path and a
# new job cannot be added without alerting. Rate-limited per job in alert.sh.
if [ $rc -ne 0 ]; then
  DETAIL="exit code: $rc"
  [ $rc -eq 124 ] && DETAIL="TIMED OUT after ${TIMEOUT_MIN}m"
  { echo "$DETAIL"; echo; echo "--- last 40 lines of $LOG ---"; tail -40 "$LOG"; } \
    | bash "$APP_DIR/infra/vps/alert.sh" "cron-$JOB" "[recrutas] cron failed: $JOB ($DETAIL)" - \
    >>"$LOG" 2>&1
fi

# Keep logs bounded (~5MB per job)
if [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  tail -c 2621440 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

exit $rc
