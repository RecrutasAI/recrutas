# VPS cron host (Hetzner)

Runs the 11 scheduled ingestion/maintenance jobs that previously ran as
GitHub Actions cron workflows (moved off GHA during the 2026-06 org
restriction; kept here because a VPS removes the single-vendor dependency).
The web app itself still deploys to Vercel — this box only runs crons.

## Layout on the server

- `/opt/recrutas/app` — clone of this repo (public, plain HTTPS clone)
- `/opt/recrutas/app/.env` — secrets, copied from the dev machine (never committed)
- `/opt/recrutas/logs/<job>.log` — per-job output, self-truncated at ~5MB

## Setup (fresh Ubuntu 24.04, as root)

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/RecrutasAI/recrutas/main/infra/vps/setup.sh)
scp .env root@<server>:/opt/recrutas/app/.env   # from the dev machine
ssh root@<server> 'bash /opt/recrutas/app/infra/vps/setup.sh'  # re-run to install crontab
```

## Operating

- **Deploy app updates:** `ssh root@<server> /opt/recrutas/app/infra/vps/deploy.sh`
- **Run a job manually:** `infra/vps/run-cron.sh <job> <timeout-min> npx tsx scripts/<script>.ts`
- **Tail a job:** `tail -f /opt/recrutas/logs/scrape-ats-jobs.log`
- **Health:** jobs still write `pipeline_runs` heartbeats, so the admin
  Pipeline Health panel keeps working regardless of where crons run.

## Schedule

See `crontab` in this directory — a 1:1 port of the `.github/workflows`
schedules (UTC), including per-job timeouts and skip-if-still-running locks.

## If GitHub Actions comes back

Disable the `schedule:` triggers in the workflow files (or keep them disabled
in the UI) before re-enabling anything — otherwise jobs double-run. The VPS is
the source of truth for crons from 2026-06 onward.
