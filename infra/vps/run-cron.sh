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

# Memory bounding. Postgres shares 1.9GB with these workers, so an unbounded
# scraper can push the DB into reclaim or get the kernel OOM-killer to pick a
# victim of its choosing. Running each job in its own cgroup scope means the job
# that overruns is the one that dies, instead of the database.
#   MemoryMax     = hard ceiling; exceeding it SIGKILLs THIS job only
#   MemorySwapMax = 0, and this is load-bearing. Without it the kernel keeps the
#                   job under MemoryMax by swapping it out, so it never dies —
#                   it just drags the whole box, and every DB query, down with
#                   it. Measured: a 1.6GB allocation sailed past MemoryMax=1300M
#                   until swap was capped.
#
# Deliberately NO MemoryHigh. It throttles allocation so hard that a runaway job
# never reaches the hard ceiling — measured twice (at 900M and 1150M) stalling
# for the full 3min timeout instead of dying. For a 90min job that is 90min of a
# crawling box. With a hard cap in place, throttling buys nothing and costs a
# fast, loud failure.
# Per-job override: CRON_MEM_MAX_<JOB>, e.g. CRON_MEM_MAX_BATCH_EMBEDDINGS=1600M
JOB_ENV="$(printf '%s' "$JOB" | tr '[:lower:]-' '[:upper:]_')"
MEM_MAX_VAR="CRON_MEM_MAX_${JOB_ENV}"
MEM_SWAP_VAR="CRON_MEM_SWAP_${JOB_ENV}"
MEM_SWAP="${!MEM_SWAP_VAR:-${CRON_MEM_SWAP:-0}}"
# 1.9GB total, Postgres ~300-450MB, OS ~200MB. Most workers peak around 460MB,
# so 1300M is a runaway ceiling, not a working limit. Note this cap also sets
# Node's own heap ceiling to roughly half of it (~650M) — see the exit-134 note
# below; a job that dies at ~650M of heap is hitting that, not this.
MEM_MAX="${!MEM_MAX_VAR:-${CRON_MEM_MAX:-1300M}}"

echo "=== $(date -u +%FT%TZ) [$JOB] start (memMax=$MEM_MAX swap=$MEM_SWAP) ===" >>"$LOG"
if command -v systemd-run >/dev/null 2>&1 && [ -e /sys/fs/cgroup/cgroup.controllers ]; then
  systemd-run --scope --quiet --collect \
    -p "MemoryMax=$MEM_MAX" -p "MemorySwapMax=$MEM_SWAP" \
    -- timeout "${TIMEOUT_MIN}m" "$@" >>"$LOG" 2>&1
  rc=$?
else
  # No cgroup support: still run, just unbounded.
  timeout "${TIMEOUT_MIN}m" "$@" >>"$LOG" 2>&1
  rc=$?
fi
[ $rc -eq 124 ] && echo "[$JOB] KILLED after ${TIMEOUT_MIN}m timeout" >>"$LOG"
[ $rc -eq 137 ] && echo "[$JOB] KILLED (SIGKILL — likely exceeded MemoryMax=$MEM_MAX)" >>"$LOG"
# 134 = SIGABRT. For a Node job this is almost always V8 aborting on its own heap
# limit ("FATAL ERROR: Reached heap limit"), which it hits WELL BELOW MemoryMax:
# Node sizes its old-space from the cgroup limit, so MemoryMax=1300M gives a
# ~650M heap ceiling. Raising MemoryMax alone does not fix it — the job has to
# stop holding that much at once (or be given --max-old-space-size to match).
[ $rc -eq 134 ] && echo "[$JOB] ABORTED (SIGABRT — for Node, usually V8 heap limit ~half of MemoryMax=$MEM_MAX, NOT the cgroup)" >>"$LOG"
echo "=== $(date -u +%FT%TZ) [$JOB] exit $rc ===" >>"$LOG"

# Alert on failure. Hooked here rather than in each script so every job — the
# health check, all four backups, the restore verifier, every scraper — is
# covered by one path and a new job cannot be added without alerting.
# Rate-limited per job in alert.sh.
if [ $rc -ne 0 ]; then
  DETAIL="exit code: $rc"
  [ $rc -eq 124 ] && DETAIL="TIMED OUT after ${TIMEOUT_MIN}m"
  [ $rc -eq 137 ] && DETAIL="OOM-KILLED (exceeded MemoryMax=$MEM_MAX)"
  [ $rc -eq 134 ] && DETAIL="ABORTED (exit 134 — likely V8 heap limit, see log)"
  { echo "$DETAIL"; echo; echo "--- last 40 lines of $LOG ---"; tail -40 "$LOG"; } \
    | bash "$APP_DIR/infra/vps/alert.sh" "cron-$JOB" "[recrutas] cron failed: $JOB ($DETAIL)" - \
    >>"$LOG" 2>&1
fi

# Keep logs bounded (~5MB per job)
if [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  tail -c 2621440 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

exit $rc
