/**
 * Job-supply watchdog — standalone cron script.
 *
 * Exists because a ~5x collapse in new job supply ran for weeks without paging
 * anyone. Every individual cron kept reporting `status=ok`: the ATS scraper was
 * genuinely healthy (it just had nothing new to find), the Greenhouse probe was
 * silently rejecting every company via a dead endpoint, and the tier-2/3
 * scrapers logged `warning`, which does not alert. Per-pipeline health said
 * green while the thing we actually care about — new jobs landing in the feed —
 * fell from ~2,000/day to ~263/day.
 *
 * So this watches OUTCOMES, not process health. Throwing marks the run failed,
 * which is what run-cron.sh turns into an alert email.
 *
 * Usage:
 *   npx tsx scripts/check-supply-health.ts [--minNewJobs=150] [--minApproved=1]
 */
import dotenv from 'dotenv';
dotenv.config();

import { client, db } from '../server/db.js';
import { sql } from 'drizzle-orm/sql';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';

function intArg(name: string, fallback: number): number {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(new RegExp(`^--${name}=(\\d+)$`));
    if (m) return parseInt(m[1], 10);
  }
  return fallback;
}

async function scalar(query: any): Promise<number> {
  const rows: any = await db!.execute(query);
  const first = (rows.rows ?? rows)[0];
  return Number(first?.n ?? 0);
}

async function main(): Promise<PipelineSummary> {
  if (!db) throw new Error('DB not available');

  const minNewJobs = intArg('minNewJobs', 150);
  const minApproved = intArg('minApproved', 1);

  const newJobs24h = await scalar(sql`
    SELECT count(*)::int AS n FROM job_postings WHERE created_at > now() - interval '24 hours'
  `);
  const activeJobs = await scalar(sql`
    SELECT count(*)::int AS n FROM job_postings WHERE status = 'active'
  `);
  // Companies approved in the last 48h — the probe is the only path to NEW
  // supply once the existing ATS pool is saturated, so a flat zero here means
  // growth has stopped even if every scraper looks healthy.
  const approved48h = await scalar(sql`
    SELECT count(*)::int AS n FROM discovered_companies
     WHERE status = 'approved' AND "updatedAt" > now() - interval '48 hours'
  `);
  const pendingBacklog = await scalar(sql`
    SELECT count(*)::int AS n FROM discovered_companies WHERE status = 'pending'
  `);

  const facts =
    `new_jobs_24h=${newJobs24h} active=${activeJobs} ` +
    `companies_approved_48h=${approved48h} probe_backlog=${pendingBacklog}`;
  console.log(`[SupplyHealth] ${facts}`);

  const breaches: string[] = [];
  if (newJobs24h < minNewJobs) {
    breaches.push(`only ${newJobs24h} new jobs in 24h (floor ${minNewJobs})`);
  }
  if (approved48h < minApproved) {
    breaches.push(`only ${approved48h} companies approved in 48h (floor ${minApproved}) — company discovery has stalled`);
  }

  if (breaches.length > 0) {
    // Throwing is deliberate: it records a failed run and exits non-zero, which
    // is the only path that actually sends mail. A 'warning' would not alert.
    throw new Error(`Job supply degraded — ${breaches.join('; ')}. [${facts}]`);
  }

  return { status: 'ok', itemsProcessed: newJobs24h, message: facts };
}

runAsPipeline('supply-health', main)
  .then(() => { client?.end(); process.exit(0); })
  .catch((err) => { console.error('[SupplyHealth] Fatal:', err.message); client?.end(); process.exit(1); });
