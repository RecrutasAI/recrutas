/**
 * CLI script for scraping external job boards (Adzuna, Jooble, JSearch, etc.)
 * Invoked by GitHub Actions 4x/day to populate the DB with fresh jobs.
 *
 * Usage:
 *   npx tsx scripts/scrape-external-jobs.ts
 *   npx tsx scripts/scrape-external-jobs.ts --timeout=300000
 */

import { jobAggregator } from '../server/job-aggregator.js';
import { jobIngestionService } from '../server/services/job-ingestion.service.js';
import { client as dbClient } from '../server/db.js';
import { recordPipelineRun } from '../server/services/pipeline-run.service.js';

function checkRequiredEnvVars(): void {
  const required = ['DATABASE_URL'];
  const missing: string[] = [];

  for (const envVar of required) {
    if (!process.env[envVar]) {
      missing.push(envVar);
    }
  }

  if (missing.length > 0) {
    console.error(`[scrape-external] ERROR: Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Log which optional sources are available
  const sources: string[] = [];
  if (process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) sources.push('Adzuna');
  if (process.env.JOOBLE_API_KEY) sources.push('Jooble');
  if (process.env.RAPIDAPI_KEY) sources.push('JSearch');
  sources.push('WeWorkRemotely', 'RemoteOK', 'TheMuse'); // always available
  console.log(`[scrape-external] Available sources: ${sources.join(', ')}`);
}

function parseArgs(): { timeout: number } {
  const args: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match) args[match[1]] = match[2];
  }
  return {
    timeout: args.timeout ? parseInt(args.timeout, 10) : 300000, // 5 min default
  };
}

function isTransientConnError(err: any): boolean {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  return msg.includes('connect_timeout') ||
         msg.includes('connection terminated') ||
         msg.includes('connection_closed') ||
         msg.includes('connection_destroyed') ||
         msg.includes('econnreset') ||
         msg.includes('etimedout') ||
         msg.includes('enetunreach');
}

// Re-probe the pool until we get a successful query. The Supabase pooler can
// intermittently reject fresh sockets with CONNECT_TIMEOUT under load, especially
// when opening a burst of new connections after a long idle scrape phase.
async function waitForDbReady(maxAttempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await dbClient`SELECT 1`;
      if (attempt > 1) console.log(`[scrape-external] DB ready after ${attempt} attempts`);
      return;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (attempt === maxAttempts) {
        throw new Error(`DB unreachable after ${maxAttempts} attempts: ${msg}`);
      }
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(`[scrape-external] DB probe ${attempt}/${maxAttempts} failed (${msg}); retrying in ${backoffMs}ms`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}

async function withConnRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (!isTransientConnError(err)) throw err;
    console.warn(`[scrape-external] ${label} hit transient connection error; re-probing and retrying once: ${err?.message}`);
    await waitForDbReady();
    return await fn();
  }
}

async function main() {
  checkRequiredEnvVars();
  const { timeout } = parseArgs();

  console.log(`[scrape-external] Starting scrape (timeout: ${timeout / 1000}s)...`);
  const startTime = Date.now();
  const startedAt = new Date(startTime);

  // Heartbeat keeps the DB connection alive during the long pure-API scrape phase.
  // Without it the connection idle-closes (~30s) and the post-scrape ingestion
  // burst hits connect_timeout opening a fresh socket to the Supabase pooler.
  const heartbeat = setInterval(() => {
    dbClient`SELECT 1`.catch(err =>
      console.warn(`[scrape-external] Heartbeat warning: ${err?.message}`)
    );
  }, 20000);

  try {
    // Fetch from all configured sources
    const jobs = await Promise.race([
      jobAggregator.getAllJobs([]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Scraping timeout')), timeout)
      ),
    ]);

    const scrapeTime = Date.now() - startTime;
    console.log(`[scrape-external] Scraped ${jobs.length} jobs in ${scrapeTime}ms`);

    if (!jobs || jobs.length === 0) {
      console.log('[scrape-external] No jobs found — exiting');
      // Healthy run that legitimately found nothing — record so the heartbeat
      // stays fresh (a real outage would have thrown instead).
      await recordPipelineRun({ pipeline: 'scrape-external', status: 'ok', startedAt, itemsProcessed: 0, message: 'no jobs found this run', stats: { scraped: 0 } });
      process.exit(0);
    }

    const normalizedJobs = jobs.map((job: any) => ({
      title: job.title || '',
      company: job.company || '',
      location: job.location || '',
      description: job.description || '',
      requirements: job.requirements || [],
      skills: job.skills || [],
      workType: job.workType || 'hybrid',
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      source: job.source || 'external',
      externalId: job.externalId || job.id || `ext-${Date.now()}`,
      externalUrl: job.externalUrl || '',
      postedDate: job.postedDate || new Date().toISOString(),
    }));

    // Probe the pool before the ingestion burst so a stale-socket failure surfaces here
    // as a retry rather than killing the whole run partway through inserts.
    await waitForDbReady();

    const ingestStats = await withConnRetry('ingestExternalJobs',
      () => jobIngestionService.ingestExternalJobs(normalizedJobs)
    );

    const totalTime = Date.now() - startTime;
    console.log(`[scrape-external] Done in ${totalTime}ms:`);
    console.log(`  Scraped:    ${jobs.length}`);
    console.log(`  Inserted:   ${ingestStats?.inserted || 0}`);
    console.log(`  Duplicates: ${ingestStats?.duplicates || 0}`);
    console.log(`  Errors:     ${ingestStats?.errors || 0}`);

    // Resolve bad URLs for existing jobs
    if (ingestStats?.inserted > 0) {
      console.log('[scrape-external] Resolving bad URLs for existing jobs...');
      const resolveResult = await withConnRetry('resolveJobUrls',
        () => jobIngestionService.resolveJobUrls()
      );
      console.log(`[scrape-external] Resolved ${resolveResult.resolved} job URLs`);
    }

    await recordPipelineRun({
      pipeline: 'scrape-external',
      status: (ingestStats?.errors || 0) > 0 ? 'warning' : 'ok',
      startedAt,
      itemsProcessed: ingestStats?.inserted || 0,
      itemsFailed: ingestStats?.errors || 0,
      message: `${jobs.length} scraped, ${ingestStats?.inserted || 0} inserted, ${ingestStats?.duplicates || 0} dupes, ${ingestStats?.errors || 0} errors`,
      stats: { scraped: jobs.length, inserted: ingestStats?.inserted || 0, duplicates: ingestStats?.duplicates || 0, errors: ingestStats?.errors || 0 },
    });
    process.exit(0);
  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    console.error(`[scrape-external] Failed after ${elapsed}ms:`, error?.message);
    await recordPipelineRun({ pipeline: 'scrape-external', status: 'failed', startedAt, message: error?.message ?? String(error) });
    process.exit(1);
  } finally {
    clearInterval(heartbeat);
  }
}

main();
