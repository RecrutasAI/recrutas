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

## Backups

Three layers, in increasing order of what they survive:

| Job | Time (UTC) | Writes | Survives |
| --- | --- | --- | --- |
| `db-backup` (`backup-supabase.sh`) | 09:00 | `/opt/recrutas/backups/db` | Supabase-side data loss |
| `vps-db-backup` (`backup-vps-db.sh`) | 09:30 | `/opt/recrutas/backups/vps-db` | bad migration / accidental delete |
| `storage-backup` (`backup-storage.sh`) | 09:45 | `/opt/recrutas/backups/storage` | loss of the résumé bucket |
| `offsite-backup` (`offsite-backup.sh`) | 10:15 | remote bucket, encrypted | **loss of the VPS itself** |

`storage-backup` exists because the SQL dumps carry the `storage` *schema* —
object metadata rows — and not one byte of any actual résumé. It downloads the
whole bucket (~492 objects / 54MB) and verifies the byte total against
Supabase's own metadata before tarring.

The first two write to the same disk as the database, so neither survives losing
the box — that is what the third is for. It is **inert until configured** and
heartbeats a `warning` in the admin Pipeline Health panel until then.

To turn it on, add to `/opt/recrutas/app/.env`:

```sh
OFFSITE_RCLONE_REMOTE=r2:recrutas-backups   # any rclone remote
OFFSITE_GPG_PASSPHRASE=<long random string> # store OUTSIDE this box
OFFSITE_RETAIN_DAYS=14                      # optional; ~5.4GB at current sizes
```

and configure the remote once with `rclone config` (Cloudflare R2 = `s3` provider
`Cloudflare`; 10GB free tier covers this). Dumps are gpg-AES256-encrypted before
upload — they contain candidate PII. **If the passphrase is only on the VPS, the
offsite copy is undecryptable in the exact scenario it exists for.**

Restore is documented in the header of `offsite-backup.sh`.

> Once Supabase auth is retired (Better Auth phase 2), drop `--schema=public`
> from `backup-supabase.sh` — that dump is ~193MB today mostly because it still
> carries a stale copy of the migrated app data.

## Operating

- **Deploy app updates:** `ssh root@<server> /opt/recrutas/app/infra/vps/deploy.sh`
  — ⚠️ this runs `git pull`, which currently **fails on the VPS**: the box has no
  GitHub credentials and the repo is not anonymously readable. Until that is
  fixed, ship code with a bundle from the dev machine:
  ```sh
  git bundle create /tmp/sync.bundle ^$(ssh root@<server> 'git -C /opt/recrutas/app rev-parse HEAD') main
  scp /tmp/sync.bundle root@<server>:/tmp/
  ssh root@<server> 'cd /opt/recrutas/app && git fetch /tmp/sync.bundle main && git reset --hard FETCH_HEAD && crontab infra/vps/crontab'
  ```
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
