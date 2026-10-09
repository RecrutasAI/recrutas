/**
 * Console actions: the buttons on the admin console's signals.
 *
 * "Run now" queues a request in admin_job_requests. The VPS's every-minute
 * Autopilot run claims it and starts the job through infra/vps/run-cron.sh (same
 * lock, timeout, memory cap and failure alert as the scheduled run), then
 * infra/vps/run-requested-job.sh records how it ended.
 *
 * Only jobs in RUNNABLE_JOBS can be started, and the VPS looks the command up
 * here by key: a request row holds a job NAME, never a command, so nothing
 * written to the database can make the server run something else. Jobs that
 * are unsafe to run twice (backups, purges, emails to users) are not listed.
 *
 * Snoozes hide a signal from "Needs attention" until a time, with a reason.
 */
import { db } from '../db';
import { sql } from 'drizzle-orm/sql';
import { writeAudit } from './runtime-settings.service';

type Conn = { execute: typeof db.execute };
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

export interface RunnableJob {
  title: string;
  /** What running it does, in plain words, for the console. */
  description: string;
  /** Name in pipeline_runs, where the job reports its result. */
  pipeline: string;
  timeoutMin: number;
  /** Command, as in infra/vps/crontab. */
  command: string[];
  /** Extra environment, as on the crontab line (lock group, AI budget…). */
  env?: Record<string, string>;
}

// Keep in step with infra/vps/crontab (test/admin-actions.test.ts checks it).
export const RUNNABLE_JOBS = {
  'batch-embeddings': {
    title: 'Match new jobs',
    description: 'Creates the matching data for new jobs so they can be matched to candidates. Normally every 6 hours.',
    pipeline: 'batch-embeddings', timeoutMin: 90,
    command: ['env', 'BATCH_LIMIT=20000', 'npx', 'tsx', 'server/services/batch-embedding.service.ts'],
    env: { CRON_LOCK_GROUP: 'embed', CRON_LOCK_WAIT_SEC: '300' },
  },
  'retry-failed-parses': {
    title: 'Retry resume parses',
    description: 'Re-reads resumes the AI could not parse (they fell back to the rule engine) through the free AI providers.',
    pipeline: 'retry-failed-parses', timeoutMin: 9,
    command: ['npx', 'tsx', 'scripts/retry-failed-parses.ts'],
    env: { PARSE_AI_TIMEOUT_MS: '90000' },
  },
  'auto-hide-ghost-jobs': {
    title: 'Hide ghost jobs',
    description: 'Hides jobs that look abandoned (no sign of life for 30 days).',
    pipeline: 'auto-hide-ghost-jobs', timeoutMin: 5,
    command: ['npx', 'tsx', 'scripts/auto-hide-ghost-jobs.ts', '--staleDays=30'],
  },
  'scrape-ats-jobs': {
    title: 'Scrape company job boards',
    description: 'Re-reads every approved company\'s job board (Greenhouse, Lever, Ashby…). Normally every 4 hours; takes up to an hour.',
    pipeline: 'scrape-ats', timeoutMin: 60,
    command: ['npx', 'tsx', 'scripts/scrape-all-company-jobs.ts'],
  },
  'compute-job-requirements': {
    title: 'Read job requirements',
    description: 'Extracts years, clearance and degree requirements from new job posts for the Apply / Stretch / Skip verdicts.',
    pipeline: 'compute-job-requirements', timeoutMin: 30,
    command: ['npx', 'tsx', 'scripts/compute-job-requirements.ts'],
  },
  'warm-candidate-matches': {
    title: 'Refresh candidate matches',
    description: 'Pre-computes each candidate\'s feed so it opens fast.',
    pipeline: 'warm-candidate-matches', timeoutMin: 10,
    command: ['npx', 'tsx', 'scripts/warm-candidate-matches.ts'],
  },
  'check-ai-models': {
    title: 'Check AI providers',
    description: 'Calls each AI provider once to confirm its model still answers.',
    pipeline: 'check-ai-models', timeoutMin: 3,
    command: ['npx', 'tsx', 'scripts/check-ai-models.ts'],
  },
  'vps-db-health': {
    title: 'Server health check',
    description: 'Checks the database, disk, RAM and load on the server and reports them here.',
    pipeline: 'vps-db-health', timeoutMin: 3,
    command: ['bash', 'infra/vps/healthcheck-db.sh'],
  },
  'supply-health': {
    title: 'Check job supply',
    description: 'Checks that enough new jobs arrived in the last day.',
    pipeline: 'supply-health', timeoutMin: 5,
    command: ['npx', 'tsx', 'scripts/check-supply-health.ts', '--minNewJobs=150', '--minApproved=1'],
  },
} as const satisfies Record<string, RunnableJob>;

export type RunnableJobKey = keyof typeof RUNNABLE_JOBS;

export function isRunnableJob(key: string): key is RunnableJobKey {
  return Object.prototype.hasOwnProperty.call(RUNNABLE_JOBS, key);
}

/** The runnable job that reports under a pipeline name, if any ("scrape-ats" → "scrape-ats-jobs"). */
export function jobForPipeline(pipeline: string): RunnableJobKey | null {
  return (Object.keys(RUNNABLE_JOBS) as RunnableJobKey[]).find(k => RUNNABLE_JOBS[k].pipeline === pipeline) ?? null;
}

export type RequestStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface JobRequest {
  id: number;
  job: string;
  requestedBy: string;
  reason: string;
  requestedAt: string;
  status: RequestStatus;
  startedAt: string | null;
  finishedAt: string | null;
  result: string | null;
}

const toRequest = (r: any): JobRequest => ({
  id: Number(r.id), job: r.job, requestedBy: r.requested_by, reason: r.reason,
  requestedAt: new Date(r.requested_at).toISOString(), status: r.status,
  startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
  finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  result: r.result ?? null,
});

/** Queue a job. Refused when the same job is already queued or running. */
export async function requestJob(job: string, actor: string, reason: string, conn: Conn = db): Promise<{ ok: true; request: JobRequest } | { ok: false; error: string }> {
  if (!isRunnableJob(job)) {return { ok: false, error: `Unknown job: ${job}` };}
  if (!reason.trim()) {return { ok: false, error: 'A reason is required.' };}
  const open = rows(await conn.execute(sql`
    SELECT id FROM admin_job_requests WHERE job = ${job} AND status IN ('queued', 'running') LIMIT 1`))[0];
  if (open) {return { ok: false, error: `${RUNNABLE_JOBS[job].title} is already queued or running.` };}
  const r = rows(await conn.execute(sql`
    INSERT INTO admin_job_requests (job, requested_by, reason) VALUES (${job}, ${actor}, ${reason.trim().slice(0, 500)})
    RETURNING *`))[0];
  await writeAudit(actor, 'job.run', job, { requestId: Number(r.id) }, reason.trim().slice(0, 500), conn);
  return { ok: true, request: toRequest(r) };
}

/** The newest request per job (for each button's status line). */
export async function latestRequests(conn: Conn = db): Promise<Record<string, JobRequest>> {
  const r = rows(await conn.execute(sql`
    SELECT DISTINCT ON (job) * FROM admin_job_requests
    WHERE requested_at > NOW() - INTERVAL '2 days' ORDER BY job, requested_at DESC`));
  return Object.fromEntries(r.map(x => [x.job, toRequest(x)]));
}

/**
 * VPS side: claim queued requests (oldest first) and mark them running. Rows
 * stuck in 'running' past their job's timeout (the runner died) are closed as
 * failed so the button frees up.
 */
export async function claimQueuedRequests(conn: Conn = db): Promise<JobRequest[]> {
  for (const [key, job] of Object.entries(RUNNABLE_JOBS)) {
    await conn.execute(sql`
      UPDATE admin_job_requests SET status = 'failed', finished_at = NOW(),
        result = 'No result recorded: the run outlived its timeout or the runner stopped.'
      WHERE job = ${key} AND status = 'running'
        AND started_at < NOW() - make_interval(mins => ${job.timeoutMin + 15})`);
  }
  // A request for a job removed from the list can never run.
  await conn.execute(sql`
    UPDATE admin_job_requests SET status = 'failed', finished_at = NOW(), result = 'This job can no longer be run from the console.'
    WHERE status = 'queued' AND job NOT IN ${Object.keys(RUNNABLE_JOBS)}`);
  const r = rows(await conn.execute(sql`
    UPDATE admin_job_requests SET status = 'running', started_at = NOW()
    WHERE id IN (SELECT id FROM admin_job_requests WHERE status = 'queued' ORDER BY requested_at LIMIT 5 FOR UPDATE SKIP LOCKED)
    RETURNING *`));
  return r.map(toRequest);
}

// ── Snoozes ──────────────────────────────────────────────────────────────────

export interface Snooze { key: string; until: string; by: string; reason: string }

export async function activeSnoozes(conn: Conn = db): Promise<Record<string, Snooze>> {
  const r = rows(await conn.execute(sql`SELECT key, until, snoozed_by, reason FROM admin_signal_snoozes WHERE until > NOW()`));
  return Object.fromEntries(r.map(x => [x.key, { key: x.key, until: new Date(x.until).toISOString(), by: x.snoozed_by, reason: x.reason }]));
}

export async function snoozeSignal(key: string, hours: number, actor: string, reason: string, conn: Conn = db): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!/^[a-zA-Z]{2,40}$/.test(key)) {return { ok: false, error: 'Unknown signal.' };}
  if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 14) {return { ok: false, error: 'Snooze between 1 hour and 14 days.' };}
  if (!reason.trim()) {return { ok: false, error: 'A reason is required.' };}
  await conn.execute(sql`
    INSERT INTO admin_signal_snoozes (key, until, snoozed_by, reason)
    VALUES (${key}, NOW() + make_interval(hours => ${Math.round(hours)}), ${actor}, ${reason.trim().slice(0, 500)})
    ON CONFLICT (key) DO UPDATE SET until = EXCLUDED.until, snoozed_by = EXCLUDED.snoozed_by, reason = EXCLUDED.reason`);
  await writeAudit(actor, 'signal.snooze', key, { hours: Math.round(hours) }, reason.trim().slice(0, 500), conn);
  return { ok: true };
}

export async function clearSnooze(key: string, actor: string, conn: Conn = db): Promise<void> {
  await conn.execute(sql`DELETE FROM admin_signal_snoozes WHERE key = ${key}`);
  await writeAudit(actor, 'signal.unsnooze', key, {}, null, conn);
}
