#!/usr/bin/env bash
# Runs one job requested from the admin console ("Run now") and records how it
# ended in admin_job_requests. Started detached by scripts/autopilot.ts, which
# looks the command up in RUNNABLE_JOBS (server/services/admin-actions.service.ts).
#
# The job goes through run-cron.sh, so it gets the same lock, timeout, memory cap
# and failure alert as its scheduled run. run-cron.sh exits 0 when it skips (lock
# held, or paused), so the log lines it wrote decide between done and skipped.
#
# Usage: run-requested-job.sh <request-id> <job> <pipeline> <timeout-min> <command...>
set -uo pipefail

APP_DIR="${RECRUTAS_DIR:-/opt/recrutas/app}"
LOG_DIR="${RECRUTAS_LOG_DIR:-/opt/recrutas/logs}"
ID="$1"; JOB="$2"; PIPELINE="$3"; shift 3

cd "$APP_DIR"
set -a
# shellcheck disable=SC1091
source .env
set +a

LOG="$LOG_DIR/$JOB.log"
BEFORE="$(stat -c%s "$LOG" 2>/dev/null || echo 0)"

bash "$APP_DIR/infra/vps/run-cron.sh" "$JOB" "$@"
RC=$?

# Only what this run wrote.
TAIL="$(tail -c +"$((BEFORE + 1))" "$LOG" 2>/dev/null | tail -40)"

STATUS=done
NOTE=""
SKIP="$(printf '%s\n' "$TAIL" | grep -E "\] (lock .* held|lock .* still held|paused by)" | tail -1 | sed -E 's/^[^]]*\] //')"
if [ -n "$SKIP" ]; then
  STATUS=skipped; NOTE="$SKIP"
elif [ "$RC" -eq 124 ]; then
  STATUS=failed; NOTE="Timed out."
elif [ "$RC" -eq 137 ]; then
  STATUS=failed; NOTE="Killed: ran out of memory."
elif [ "$RC" -ne 0 ]; then
  STATUS=failed; NOTE="Exited with code $RC. Last lines: $(printf '%s\n' "$TAIL" | grep -v '^===' | tail -3 | tr '\n' ' ' | cut -c1-300)"
fi

# The job's own summary (pipeline_runs) is the most useful result; the note says why when it didn't run.
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v id="$ID" -v status="$STATUS" -v note="$NOTE" -v pipeline="$PIPELINE" <<'SQL'
UPDATE admin_job_requests r SET
  status = :'status',
  finished_at = NOW(),
  result = COALESCE(NULLIF(:'note', ''), (
    SELECT p.message FROM pipeline_runs p
    WHERE p.pipeline = :'pipeline' AND p.started_at >= r.started_at - INTERVAL '1 minute'
    ORDER BY p.started_at DESC LIMIT 1
  ), 'Finished.')
WHERE r.id = :'id'::int;
SQL
