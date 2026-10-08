# Scaling strategy

How Recrutas grows from today's ~50 users to a launch spike of tens of thousands without breaking.
The rule: **do less work per user, and when we run out of room, get slower and more polite rather than falling over.**

Written 2026-10-08. Facts marked *verified* were checked against production or the code that day.
Facts marked *from notes* come from earlier sessions and should be re-checked before relying on them.

## 1. Where we are

| | Today | Source |
|---|---|---|
| Database server | Hetzner VPS: 2 vCPU, 1.9 GB RAM, 38 GB disk (53% used) | verified |
| Database | Postgres + pgvector on that VPS, 4.1 GB; `max_connections = 60` (7 in use); no connection pooler | verified |
| Active jobs | 155,880 (72K in July; box upgrade planned at ~250K) | verified |
| Web/API | Vercel serverless functions; each instance opens its own DB connection | verified |
| Feed | `getJobRecommendations` → `fetchScoredJobs` re-scores the **whole** feed (up to 100 results) on every visit, refresh, background refetch and filter change; the client then pages through those results locally. ~720 ms warm at 72K jobs (July); likely higher now | verified (code) / from notes (timing) |
| Match warming | `warm-candidate-matches` (daily 04:30) recomputes every candidate's feed but stores nothing, so the work is thrown away | verified |
| Resume parsing | Synchronous inside the upload request; AI first (Groq gpt-oss-20b, Gemini fallback), then a rules parser that does badly on LinkedIn PDF exports. Degraded parses are tracked (`resume_parsed.degraded`). `retry-failed-parses` runs hourly | verified |
| AI budget | Free tiers: ~200K Groq tokens/day ≈ 60 resumes/day | from notes (2026-10-02) |
| Candidate embeddings | `embed-candidates` every minute on the VPS (local ONNX, CPU) | verified |
| Sign-up email | Supabase confirmation emails capped at 30/hour, sent through Resend (plan unknown) | from notes (2026-09-27) |
| Heavy crons on the same 2 cores | scrapers (every 4 h + 06/18), job embeddings (4×/day, 20K batch), discovery (02:00), backups | verified |

## 2. What breaks, in order

For a spike of 50,000 sign-ups over a few days on today's stack:

1. **Sign-up email (30/hour).** Almost everyone stalls at "check your email". Only Google sign-in gets through.
2. **AI resume parsing (~60/day).** Nearly everyone gets the weak rules parse, which means worse matches and verdicts on day one, the moment trust is decided.
3. **DB connections (60).** A burst of Vercel instances exhausts them, and requests start failing.
4. **Feed CPU.** Every visit costs a full re-score on 2 cores shared with scrapers and embedding. At 1–2% concurrency (500–1,000 people) pages time out.
5. **Candidate embedding backlog.** Each new resume waits in a CPU queue on the same box.
6. **RAM.** The vector index wants to be in memory; at ~250K jobs it stops fitting in 1.9 GB.

Steady growth hits the same walls in the same order, just later.

## 3. Principles

- **Do work once.** Compute a person's ranked feed once and reuse it across visits and refreshes, and re-score only when their profile or the job pool actually changes.
- **Move slow work out of the request.** Uploads and sign-ups return fast; parsing and embedding happen in queues, and the UI says what's happening.
- **Degrade in a fixed order, never fail closed.** See the ladder in section 6.
- **Scale on signals, not guesses.** Each step below has a trigger metric; we act when it fires.
- **Keep the product model untouched.** Direct-from-employer jobs, scoring, verdicts and the after-apply loop all survive every step. This is plumbing.

## 4. The plan

### Phase 0: before the launch video goes out (target: survive a 5–10K spike)

| # | Change | Why | Owner | Cost |
|---|---|---|---|---|
| 0.1 | **Feed cache.** Store each candidate's ranked list (job ids + scores) in a Postgres table keyed by candidate + filter hash. Invalidate when their resume/preferences change; refresh after ingestion. Visits, refreshes and repeat filters read the cache; hides, applications and closed jobs are filtered out at read time so the cache never shows them. Make `warm-candidate-matches` fill it. | Removes the per-request re-score: the biggest CPU win, roughly 5–10× more users on the same box | Engineering (PR) | none |
| 0.2 | **Connection pooler.** pgBouncer in transaction mode on the VPS; Vercel connects through it. | Bursts queue instead of exhausting 60 connections | Engineering, production change, needs explicit OK | none |
| 0.3 | **Async resume parsing.** Upload stores the file and returns; a queue does the AI parse; the dashboard shows "Reading your resume, your feed is ready in a few minutes". When the AI budget is out, the job waits rather than settling for the rules parse. `retry-failed-parses` also retries degraded parses. | Every user gets the good parse, just later; no slow uploads during a spike | Engineering (PR) | none |
| 0.4 | **Capacity alerts** through the existing alert email: feed p95 > 2 s, DB connections > 40, AI budget > 80% used, degraded-parse rate > 10%, embedding backlog > 500. | We hear about it before users do | Engineering (PR) | none |
| 0.5 | **Overload switches in a database settings table** (no deploy needed): sign-up waitlist, pause non-essential crons, feed cache on/off and TTL, site notice banner. Flipped by an admin in the console or by Autopilot (6a). | Keeps the site up for people already in, politely | Engineering (PR) | none |
| 0.6 | **Raise the sign-up email limit** in Supabase, and move Resend to a paid plan if it's on free. Make Google sign-in the first button. | Sign-ups past 30/hour get their email | Founder | ~$20/mo |
| 0.7 | **Upgrade the VPS** to 8 GB RAM (more vCPU if the price is close). | Headroom past 250K jobs and for the spike | Founder (Hetzner console) | ~€15/mo |
| 0.8 | **Fund AI parsing** with a paid tier on the current model (no code change). | Removes the 60/day ceiling | Founder | ~$25–50 per 50K resumes (re-check prices) |

### Phase 1: steady growth (trigger: ~1,000 weekly active users or feed p95 > 1 s)

- Precompute matches **at ingestion**: when new jobs land, score them against candidates whose profiles could match, rather than waiting for a visit.
- Move scrapers and job embedding to a second small box so they never compete with user traffic.
- Load-test the spike path (sign-up → upload → feed) at 10× expected peak before any big marketing push.

### Phase 2: real scale (trigger: ~5,000 weekly active users, ~250K+ active jobs, or DB CPU > 70% sustained)

- Database on its own server (16 GB+), app crons elsewhere.
- Redesign `warm-candidate-matches` to work incrementally (it loops every candidate; at 200K users that's ~40 CPU-hours a day).
- Read replica for feed and search reads.

### Phase 3: beyond (trigger: an outage that costs real users, or restore time measured in hours being unacceptable)

- Managed Postgres with failover.
- Dedicated vector search if pgvector becomes the bottleneck.

## 5. Signals and triggers

| Signal | Healthy | Act at | Action |
|---|---|---|---|
| Feed p95 latency | < 500 ms | > 2 s | Check cache hit rate; then Phase 1 |
| DB connections | < 20 | > 40 | Check pgBouncer; then a bigger pool / box |
| AI budget used (daily) | < 50% | > 80% | Fund more; queue absorbs the rest |
| Degraded parses | < 2% | > 10% | AI provider down or budget out: alert + queue |
| Embedding backlog | < 50 | > 500 | Pause non-essential crons; then move embedding off-box |
| Sign-up email bounces/blocks | 0 | any | Raise the limit; check Resend plan |
| Active jobs | — | 250K | Box upgrade (0.7) |
| VPS RAM free | > 400 MB | < 200 MB | Box upgrade |

## 6. The degradation ladder (what happens on a spike, in order)

1. Feed served from cache, even if a few minutes old.
2. Resume parsing queues; users see an honest "ready in a few minutes".
3. Non-essential crons pause (`CRON_PAUSE_NONESSENTIAL`).
4. New sign-ups go to a numbered waitlist (`SIGNUP_WAITLIST`); existing users are unaffected.
5. Never: error pages, lost uploads, or a silently worse parse presented as final.

## 6a. Autopilot: the system protects itself

A guardian job on the VPS checks the signals in section 5 **every minute** and flips the protective switches itself, then turns them back off when things recover. Switches live in a database settings table (read at most once a minute by the site and the crons), so nothing needs a deploy. The admin console's System & scaling tab shows every signal, every switch and every Autopilot action.

| When | Autopilot does | Reverts when |
|---|---|---|
| Feed p95 > 2 s, or CPU load > 1.5 × cores | Feed cache on; cache TTL 2 h → 6 h | Feed p95 < 1 s for 15 min |
| CPU load > 1.5 × cores or RAM available < 200 MB | Pause non-essential crons (discovery, external scrapes, ghost detection, warming) | Healthy for 15 min |
| DB connections > 40 | Pause non-essential crons; show the "busy" notice banner | < 25 for 15 min |
| AI budget > 80% used | Resume parsing queue-only (no weak rules parse as a final result) | Budget resets |
| Two or more of the above at once, or 5xx rate > 5% | Sign-up waitlist on (existing users unaffected) | Healthy for 30 min |
| Disk > 85% | Alert only | — |

Safety rules:
- It only flips protective switches. It never deletes data or changes infrastructure.
- Hysteresis: separate on/off thresholds plus a minimum hold time, so switches don't flap.
- Every action is emailed and written to the audit log with the signal that caused it.
- An admin can pin any switch (Autopilot leaves pinned switches alone) or turn Autopilot off entirely.
- What it can't do: add database capacity. It reports when an upgrade is due (for example, sustained pressure for three days) with the exact steps.

## 7. Auto-scaling

- **Web/API: already automatic.** Vercel adds function instances with traffic. On its own that makes the database problem worse: more instances means more connections, which is why the pooler (0.2) comes first.
- **Database: not automatic today.** A single Hetzner VPS has no autoscaling; resizing is manual with a few minutes of downtime. Phase 0 compensates by doing less work per user (cache, queues) and degrading politely (section 6).
- **Background work:** the queues in 0.3 make workers easy to scale later. Add a second worker box (Phase 1) before considering autoscaled workers.
- **When to adopt autoscaling for the database:** at Phase 2/3, choose between a bigger self-managed server (cheapest, manual) and a managed Postgres that autoscales compute with pgvector and pooling built in (for example Neon, or AWS Aurora Serverless v2). Decide on cost at that time, the team's appetite for running a database, and whether a few minutes of resize downtime is still acceptable.

## 8. What we deliberately don't do now

- No microservices, Kubernetes or managed queues. Postgres tables plus the existing VPS cron runner are enough well past 10K users.
- No chasing job volume for its own sake (RAM is the binding constraint, and users want the right 50 jobs, not 3 million).
- No building Phase 2 before its trigger fires.

## 9. Open questions to check before the PR

- Current feed p95 at 156K jobs (measure; the 720 ms figure is from July at 72K).
- Supabase auth email limit and Resend plan (dashboard).
- Vercel plan and function concurrency limits.
- Supabase Storage plan (50K resumes ≈ 10 GB).
- AI provider paid-tier prices for the current models.
