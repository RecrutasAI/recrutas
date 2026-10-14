<p align="center">
  <img src="client/public/favicon.svg" alt="Recrutas" width="80" height="80" />
</p>

<h1 align="center">Recrutas</h1>

<p align="center">
  <strong>Know where to apply. Know what happened.</strong><br />
  Live US jobs from company career pages, matched to your resume with an honest verdict,<br />
  and a job search that tells you what happened after you apply.
</p>

<p align="center">
  <a href="https://www.recrutas.ai">recrutas.ai</a> ·
  <a href="docs/ONBOARDING.md">Onboarding</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="https://www.recrutas.ai/docs">MCP connector</a> ·
  <a href="https://www.reddit.com/r/recrutas/">r/recrutas</a>
</p>

---

## What it does

Recrutas is a free job search for people looking for work in the US. Today (phase 1) the candidate side is live; the employer side is built but not open yet.

| | |
|---|---|
| **Jobs straight from the company** | Every job is read from the employer's own hiring system (Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Workday, Oracle and more), links to the real posting, and is closed when the company takes it down. No job boards, reposters or staffing agencies in the main feed. US only. |
| **Matched to your resume** | Upload a resume once; get up to 100 matches ranked by your titles, skills and seniority, each with the reason it fits. Filter by place, work type, posting date, level and company. |
| **An honest verdict** | Each match says **Apply**, **Stretch** or **Skip**, with the reason (*requires an active clearance*, *asks for 7 years, you have 4*, *won't sponsor a visa*). Posting dates are the employer's, never our first-seen date. |
| **Apply without retyping** | The Recrutas Auto-Fill extension ([Chrome](https://chromewebstore.google.com/detail/recrutas-auto-fill/elkkoaiedhfaefokoilmffmooiengdij), [Firefox](https://addons.mozilla.org/en-US/firefox/addon/recrutas-auto-fill/)) fills application forms from your profile. You review and submit; nothing is sent for you. |
| **Know what happened** | Recrutas watches the jobs you applied to and tells you when one is taken down or reposted. |
| **In your AI tools** | An [MCP connector](docs/MCP.md) for Claude Code, Cursor and other MCP clients. |

---

## Where the project stands (October 2026)

**In one line:** the candidate side is finished and in daily use; the public launch is planned for late October 2026; the employer side comes after.

**Live today**
- **Over 1.1 million US jobs from 17,800+ companies**, every one read from the company's own hiring system, with a link to the real posting. Jobs disappear from Recrutas when the company takes them down.
- **Resume matching for any line of work**, not just tech: nurses, teachers, trades, sales and office roles get matches ranked by their titles, skills and experience, with a plain-English reason for each.
- **Apply / Stretch / Skip** on every match, so you know before you apply whether a job requires a clearance, citizenship or more years than you have.
- **The Auto-Fill extension** for Chrome and Firefox. It fills only what it knows from your profile, marks what it couldn't, and never submits for you.
- **After you apply**, Recrutas tells you when a job you applied to is taken down or reposted.
- **An MCP connector**, tested with Claude Code, for asking an AI assistant about your matches.

**Built but not switched on**
- **The employer side** (job posts, skills exams, direct chat with candidates). This is phase 2.
- **A backup sign-in server** that takes over if Supabase sign-in goes down. It's installed but not yet armed.

**Known limits, stated plainly**
- **US jobs only**, for now.
- **Resumes are read by free AI services in turn.** On a very busy day some resumes are read by a simpler rules-based parser and upgraded later.
- **Email runs on a free plan** (about 85 email sign-ups a day; Google sign-up has no limit).
- **Skills for some occupations are still being improved.** Matching always looks at the role and experience as well.

---

## How it runs

| Piece | Where | Notes |
|---|---|---|
| Web app (React 18 + Vite) and API (Express) | Vercel | Auto-deploys from `main`. The API is serverless (`api/index.js`). |
| Database: PostgreSQL 17 + pgvector | Self-hosted on a Hetzner VPS, behind pgBouncer | Holds jobs, profiles, matches, the feed cache and every switch. |
| Sign-in and resume files | Supabase (Auth + Storage) | Nothing else. The API checks sign-in tokens itself (`server/middleware/auth.ts`). If Supabase Storage is down, resumes are kept in Postgres and moved back later (`server/lib/resume-files.ts`). A backup sign-in server is installed on the VPS (`infra/vps/auth/`) but not yet armed. |
| Job supply | "The Fleet" and the matcher (separate repos) on GitHub Actions + Hugging Face | Reads company hiring systems daily (over 1.1M US jobs from 17,800+ companies, Oct 2026); only jobs that match a real person are loaded into our database (`scripts/fleet-matcher.ts`). Skills are read from posting text by one shared extractor (`server/utils/skill-extractor.ts`). |
| Scheduled jobs | VPS cron (`infra/vps/crontab`) | ATS scrapes, liveness checks, place keys, embeddings, parse retries, backups. A failed job emails the owner and the dev inbox; a job that stops running is caught by a stale-job check every 30 minutes. |
| Protection under load | Autopilot (`scripts/autopilot.ts`, every minute) + the feed gate | Stretches the cache, pauses background jobs, shows a banner, caps concurrent feed scoring; flips back on recovery. |
| Resume AI | Free providers in rotation (Groq → Gemini → OpenRouter → Cloudflare), then a rules parser | `server/lib/ai-client.ts`. |
| Backups | pgBackRest to Cloudflare R2 (encrypted) + nightly dumps, with weekly restore tests | `infra/vps/README.md`. |

---

## Run it locally

**Prerequisites:** Node.js 22 (`engines` in `package.json`), npm 10+, PostgreSQL 17 with pgvector, and a Supabase project for sign-in and storage.

```bash
git clone https://github.com/RecrutasAI/recrutas.git
cd recrutas
npm install
cp .env.example .env   # fill in DATABASE_URL, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
                       # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET, and an AI key (e.g. GROQ_API_KEY)
npm run dev:all        # frontend http://localhost:5173 · API http://localhost:5000
```

Set `VERCEL=1` when running the API against a shared database: it turns off the background jobs the server would otherwise start. Never commit real credentials, including test accounts: this repository is public.

### Checks CI runs (run them all before opening a PR)

```bash
npm run type-check          # TypeScript
npm run lint                # ESLint (errors fail CI)
npm run test:unit:backend   # Jest
npm run test:server         # server tests (vitest, test/*.test.ts)
npx vitest run              # frontend tests (client/src/__tests__)
```

---

## How the code is laid out

| Path | What's there |
|---|---|
| `client/src/` | React app: pages in `pages/`, the feed in `components/ai-job-feed.tsx`, the admin console in `components/admin/`. |
| `server/routes.ts` | Express API. Start here and follow a route into `storage.ts` and `services/`. |
| `server/storage.ts` | Data access, including the feed (`getJobRecommendations`). |
| `server/services/` | Ingestion, feed cache and gate, Autopilot, applications, alerts, resumes. |
| `server/lib/` | Shared helpers: AI client, verdicts (`hard-requirements.ts`), resume files, posting dates, work type. |
| `shared/` | Drizzle schema (`schema.ts`) and the place resolver (`places.ts`). |
| `migrations/` | Idempotent SQL, applied by hand on the VPS database. |
| `scripts/` | Cron jobs and one-off operations, run on the VPS through `infra/vps/run-cron.sh`. |
| `infra/vps/` | The production server: crontab, deploy (`push-deploy.sh`), backups, alerts. |
| `extension/` | The Auto-Fill browser extension and its real-browser benchmark. |
| `test/` | Server tests (vitest + Jest). |
| `docs/` | [Onboarding](docs/ONBOARDING.md), [architecture](docs/ARCHITECTURE.md), [scaling](docs/scaling-strategy.md), [MCP](docs/MCP.md). Older reports are in `docs/archive/`. |

---

## Deploying

- **Web app and API:** merge to `main`; Vercel deploys it.
- **VPS (crons, scripts, Autopilot):** `bash infra/vps/push-deploy.sh` from a checkout of `main`. It ships a git bundle and reinstalls the crontab.
- **Database changes:** add an idempotent SQL file to `migrations/` and apply it on the VPS database with `psql` before (or with) the code that needs it. There is no automatic `db:push` in production.

## Contributing

1. Branch from `main`.
2. Make the change, with tests that use real examples.
3. Run the checks above.
4. Open a PR against `main`; CI must pass.

Questions and ideas: [r/recrutas](https://www.reddit.com/r/recrutas/).

<p align="center">
  <sub>Built in Seattle.</sub>
</p>
