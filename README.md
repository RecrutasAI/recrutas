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
  <a href="https://www.recrutas.ai/docs">Developer docs (MCP)</a> ·
  <a href="https://www.recrutas.ai/manifesto">Manifesto</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a>
</p>

---

## What it does

Job seekers send applications into silence. Recrutas is built to answer two questions every job seeker has: *which jobs can I actually get?* and *what happened to the ones I applied to?*

| | |
|---|---|
| **Live jobs, direct from companies** | Roles read straight from each employer's own hiring system (Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Breezy, Recruitee), re-checked every few hours, closed when the company takes them down. No reposters, no aggregator spam. |
| **Matched to your resume** | Upload a resume once; get up to 100 live matches ranked by your titles, skills and seniority, each with the reason it fits. |
| **An honest verdict** | Every match is marked **Apply**, **Stretch** or **Skip**, with the reason: *requires an active Secret clearance*, *asks for 7 years, you have 4*, *won't sponsor a visa*. |
| **Apply without retyping** | A browser extension (Firefox) fills application forms from your profile, screening answers included. You review and submit; nothing is ever sent for you. |
| **Know what happened** | Recrutas watches every job you applied to and tells you when it's taken down or reposted, explains why you may not be hearing back, and (over MCP) sums up your week. |
| **Job-search log** | On unemployment? Your weekly log fills itself from your applications (Washington ESD format), with CSV and print. |
| **In your AI tools** | An [MCP connector](https://www.recrutas.ai/docs) for Claude Code, Codex, Cursor and other MCP clients: ask which matches to apply to and what happened to your applications. |

Free for candidates.

---

## Run it locally

**Prerequisites:** Node.js 20+ (CI uses 22), npm 10+, a Supabase project (auth + storage), and PostgreSQL 17 with pgvector.

```bash
git clone https://github.com/RecrutasAI/recrutas.git
cd recrutas
npm install
cp .env.example .env      # fill in DATABASE_URL, Supabase keys, and an AI key (see docs/ARCHITECTURE.md#environment-variables)
npm run dev:all           # frontend http://localhost:5173 · API http://localhost:5000
```

Create a local account through the sign-up page. Never commit real credentials, including test accounts: this repository is public.

### Checks CI runs (run all four before opening a PR)

```bash
npm run type-check                                        # TypeScript
npx eslint client/src server shared                       # ESLint (errors fail CI)
npm run test:unit:backend                                 # Jest
npx vitest run --config vitest.server.config.ts           # server tests
npx vitest run                                            # frontend tests
```

---

## How the code is laid out

| Path | What's there |
|---|---|
| `client/src/` | React 18 + Vite + TanStack Query + Tailwind/shadcn. Pages in `pages/`, dashboard pieces in `components/`. |
| `server/routes.ts` | Express API: start here and follow a route into `storage.ts` and `services/`. |
| `server/storage.ts` | Data access, including the matching feed (`getJobRecommendations`). |
| `server/services/` | Application tracking, take-down/repost alerts, diagnosis, weekly summary, tokens, ingestion. |
| `server/lib/hard-requirements.ts` | Reads clearance, citizenship, sponsorship and years requirements; the Apply/Stretch/Skip verdict. |
| `server/mcp/` | The MCP connector (`POST /api/mcp`). |
| `shared/schema.ts` | Drizzle schema: the contract between client, server and database. |
| `extension/` | The browser extension, plus `bench/` (real-browser autofill benchmark and tracking tests). |
| `scripts/` | Cron jobs and one-off operations (run on the VPS through `infra/vps/run-cron.sh`). |
| `infra/vps/` | Production server: crontab, deploy (`push-deploy.sh`), backups, alerts. |
| `docs/` | [Architecture deep dive](docs/ARCHITECTURE.md), [MCP connector](docs/MCP.md), deployment notes. |

**Where things run:** the web app and API on Vercel (auto-deploys from `main`); PostgreSQL + pgvector, scrapers and scheduled jobs on a self-hosted VPS (deploy with `infra/vps/push-deploy.sh`). Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Contributing

1. Branch from `main`.
2. Make the change, with tests.
3. Run the four checks above.
4. Open a PR against `main`; CI must pass.

Database changes ship as idempotent SQL in `migrations/` (see `migrations/add-api-tokens.sql`), applied deliberately, never by an automatic push.

<p align="center">
  <sub>Built in Seattle.</sub>
</p>
