# Onboarding

A first-day guide for engineers and coding agents working on Recrutas. Read the
[README](../README.md) first for what the product is and how to run it.

## The principles every change is judged by

1. **Direct from the company.** The main feed shows jobs from the employer's own hiring system. Job boards, reposters and staffing agencies appear only when a person has no direct matches, and are labeled.
2. **US only.** A job outside the US never reaches the feed, including the fallback paths.
3. **Real links.** Every job links to the actual posting, never a homepage or careers landing page.
4. **Truthful, never guessed.** Posting dates are the employer's, never our first-seen date; a field we don't know stays empty; emails and UI copy promise only what is live.
5. **Frugal.** Free tiers until a meter says pay. Prefer our own Postgres over a new service.
6. **Easy on the server.** One 2-core VPS runs the database. Bulk `UPDATE`s need a `WHERE` that skips unchanged rows; heavy work runs off the box.

When an example of a bug is reported, fix the general case and test it on real data, not just the example.

## Repo map

| Path | One line |
|---|---|
| `client/src/pages/candidate-dashboard-streamlined.tsx` | The signed-in candidate app (feed, saved, applications, profile). |
| `client/src/components/ai-job-feed.tsx` | The feed: filters, cards, verdicts, "busy" state. |
| `client/src/components/location-picker.tsx` | City/state picker; applies only on pick or Enter. |
| `client/src/components/admin/` | The admin console (Today, System & scaling, switches, audit log). |
| `server/routes.ts` | Most API routes, including `GET /api/ai-matches` (the feed). |
| `server/routes/admin-console.ts` | Admin console API. |
| `server/middleware/auth.ts` | Verifies Supabase sign-in tokens locally with `SUPABASE_JWT_SECRET`. |
| `server/storage.ts` | Data access; `getJobRecommendations` and `fetchScoredJobs` build the feed. |
| `server/job-scorer.ts` | Scores a job against a candidate. |
| `server/lib/hard-requirements.ts` | Apply / Stretch / Skip verdicts. |
| `server/services/feed-cache.service.ts` | Per-person cached feed, keyed by filters. |
| `server/services/feed-gate.service.ts` | Caps how many feeds are scored at once (slots in `feed_gate_slots`). |
| `server/services/autopilot.service.ts` | Autopilot's rules (pure, unit-tested); `scripts/autopilot.ts` runs them every minute. |
| `server/services/runtime-settings.service.ts` | Live switches (feed cache, waitlist, banner, gate slots, Autopilot). |
| `server/services/job-ingestion.service.ts` | Writes scraped jobs; gated refreshes; posting dates; place keys reset. |
| `server/lib/resume-files.ts` | Resume storage: Supabase first, Postgres fallback, signed links. |
| `server/lib/ai-client.ts` | AI provider rotation for resume parsing. |
| `shared/schema.ts` | Drizzle schema shared by client and server. |
| `shared/places.ts` | Resolves any written location to US place keys (`seattle|WA`, `state|WA`, `remote`). |
| `client/public/us-places.json` | The Census place list the resolver and picker use. |
| `scripts/fleet-matcher.ts` | Exports candidates to the matcher and ingests matched Fleet jobs. |
| `scripts/scrape-all-company-jobs.ts` | Reads approved company boards from their ATS. |
| `scripts/compute-location-keys.ts` | Fills `job_postings.location_keys` hourly (weekly full recompute). |
| `scripts/check-smartrecruiters-liveness.ts` | Closes SmartRecruiters jobs the employer took down. |
| `scripts/move-fallback-resumes.ts` | Moves resumes kept in Postgres back to Supabase. |
| `migrations/` | Idempotent SQL, applied by hand. |
| `infra/vps/` | Crontab, `push-deploy.sh`, backups, `alert.sh`, restore tests. |
| `extension/` | Auto-Fill extension (Chrome + Firefox) and `bench/`. |
| `test/` | Server tests; real-data cases live next to the code they guard (e.g. `test/places.test.ts`). |

## How a feed request flows

1. The page calls `GET /api/ai-matches` with the filters (`location`, `workType`, `postedWithin`); search, company and level filter client-side over that result.
2. `storage.getJobRecommendations` reads the person's cached feed for those filters (`feed-cache.service.ts`).
3. On a cache miss it asks the feed gate for a scoring slot. Over the cap it serves the person's last feed (marked `refreshing`), else waits up to 6 s, else serves the quick fallback feed.
4. With a slot, `fetchScoredJobs` retrieves candidates (vector and keyword lanes sharing one set of eligibility rules: active, direct, US-only, real URL), scores them, drops anything under 30, collapses duplicate roles, and keeps the top 100.
5. The page of results gets Apply / Stretch / Skip verdicts (`attachVerdicts`) and goes back to the client.
6. Third-party jobs (boards, agencies) are added only when nothing is filtered and there are zero direct matches.

## How jobs get in

- **The Fleet** (separate repo, GitHub Actions) reads ~15K company boards and writes a private Hugging Face dataset. **The matcher** (separate private repo) matches it to exported candidates. `scripts/fleet-matcher.ts` exports candidates and ingests only matched jobs, with posting dates.
- **ATS scrapers** on the VPS (`scripts/scrape-all-company-jobs.ts`, `scripts/scrape-tier.ts`) read approved boards directly; `job-ingestion.service.ts` dedupes on the vendor job id and refreshes title, location and work type when they change.
- **Work type** comes from the ATS when it says so (Ashby/Lever `workplaceType`, SmartRecruiters and Recruitee flags, Workable `telecommuting`), otherwise `server/lib/work-type.ts`.
- **Places:** `compute-location-keys` turns each location into keys with `shared/places.ts`; the location filter matches keys, so "Seattle" finds every way a post writes Seattle.
- **Posting dates:** from the ATS or the job page (`server/lib/posted-date.ts`); undated jobs never show as recent.
- **Closing:** snapshot expiry closes jobs missing from a cleanly read board; SmartRecruiters jobs are asked about one by one.

## Running production

- **Admin console** (`/admin`): Today (signals, run-now jobs), System & scaling (switches, pipelines, errors, audit log). Every change asks for a reason and is logged.
- **Autopilot** runs every minute on the VPS. Under pressure it stretches the feed cache, pauses background jobs, shows a banner, and as a last step turns on the sign-up waitlist; it undoes only its own changes after 15 healthy minutes. It also posts a sign-in banner when Supabase is down. Pin a switch to keep Autopilot off it.
- **Alerts:** any failing cron emails through `infra/vps/alert.sh` (one mail per job per 6 h).
- **Pipelines:** each cron writes a `pipeline_runs` row; the console shows them.
- **Backups:** pgBackRest to R2 (weekly full, daily incremental, WAL for point-in-time recovery), nightly dumps, weekly automated restore test. See `infra/vps/README.md`.
- **Migrations:** write an idempotent file in `migrations/`, apply it on the VPS database with `psql`, then ship the code. Never `db:push` in production.
- **Deploys:** Vercel on merge to `main`; VPS with `bash infra/vps/push-deploy.sh` (git bundle; `git pull` does not work on the box).

## Gotchas

- **Static files go in `client/public/`.** The app builds from `client/`, so that is Vite's public directory; a file put anywhere else is missing in production, hidden behind the SPA's 200 HTML response.
- **`VERCEL=1` turns off background jobs** when you run the API locally against a shared database. Locally it also gives each process only 3 DB connections.
- **Load tests through an ssh tunnel measure the tunnel.** Test load against production (Vercel sits next to the database), at quiet hours.
- **Upstash Redis is gone** (its host no longer resolves). `server/lib/redis.ts` falls back to in-process memory; anything shared across instances belongs in Postgres.
- **Never `pkill -f` / `pgrep -f` a pattern that appears in your own command line**; it kills your shell. Find the PID another way.
- **Postgres does not skip no-op `UPDATE`s.** Ungated bulk updates once wrote ~5 GB of WAL a day and filled the disk.
- **Supabase is only sign-in and resume files.** Don't add tables there; the database is the VPS.
- **Copy:** write "resume", not "résumé", and don't promise employer features (chat, exams, response times) to candidates until they are open.
- **Never commit secrets,** test-account passwords, connection strings or server addresses. The repo is public.
