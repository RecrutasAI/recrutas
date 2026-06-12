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

# Keep logs bounded (~5MB per job)
if [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  tail -c 2621440 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

exit $rc
