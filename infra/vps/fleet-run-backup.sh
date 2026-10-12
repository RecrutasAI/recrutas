#!/usr/bin/env bash
# Starts the day's Fleet run (RecrutasAI/jobs-fleet, fleet-run.yml) when GitHub's own
# schedule didn't. That schedule (11:17 UTC) has never fired in jobs-fleet: every run up to
# 2026-10-12 was started by hand, while schedules in our other repos fire normally. So the
# VPS checks after the slot and starts the run itself; if GitHub's schedule ever does fire,
# this sees that day's run and does nothing.
#
# Needs FLEET_DISPATCH_TOKEN in .env: a fine-grained GitHub token for jobs-fleet only,
# permission "Actions: read and write". Exits non-zero (run-cron.sh alerts) when the token
# is missing, the check fails or GitHub refuses to start the run.
set -euo pipefail

REPO="RecrutasAI/jobs-fleet"
WORKFLOW="fleet-run.yml"
API="https://api.github.com/repos/$REPO/actions/workflows/$WORKFLOW"

if [ -z "${FLEET_DISPATCH_TOKEN:-}" ]; then
  echo "FLEET_DISPATCH_TOKEN is not set in .env: can't check or start the Fleet run" >&2
  exit 1
fi
gh_api() {
  curl -fsS --max-time 30 -H "Authorization: Bearer $FLEET_DISPATCH_TOKEN" \
    -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}

TODAY="$(date -u +%F)"
RUNS_TODAY="$(gh_api "$API/runs?created=%3E%3D$TODAY&per_page=1" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["total_count"])')"
if [ "$RUNS_TODAY" -gt 0 ]; then
  echo "Fleet run already started today ($RUNS_TODAY run(s) since $TODAY 00:00 UTC); nothing to do"
  exit 0
fi

gh_api -X POST "$API/dispatches" -d '{"ref":"main"}'
echo "No Fleet run today: started one (GitHub's 11:17 schedule didn't fire)"
