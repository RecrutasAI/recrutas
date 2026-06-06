/**
 * CLI script for tiered tech company scraping.
 * Invoked by GitHub Actions to scrape a subset of companies.
 *
 * Usage:
 *   npx tsx scripts/scrape-tier.ts --tier=1 --timeout=900000
 *   npx tsx scripts/scrape-tier.ts --tier=2 --timeout=600000
 *   npx tsx scripts/scrape-tier.ts --tier=3 --timeout=300000
 *   npx tsx scripts/scrape-tier.ts --cleanup --days=15
 */

import { SOTAScraperService } from '../server/services/sota-scraper.service.js';
import { jobIngestionService } from '../server/services/job-ingestion.service.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';

function checkRequiredEnvVars(): void {
  const required = ['DATABASE_URL'];
  const missing: string[] = [];
  
  for (const envVar of required) {
    if (!process.env[envVar]) {
      missing.push(envVar);
    }
  }
  
  if (missing.length > 0) {
    console.error(`[scrape-tier] ERROR: Missing required environment variables: ${missing.join(', ')}`);
    console.error('[scrape-tier] Aborting scrape. Please set these in GitHub Actions secrets.');
    process.exit(1);
  }
  
  console.log('[scrape-tier] Environment variables verified');
}

function parseArgs(): { tier?: number; timeout?: number; cleanup?: boolean; days?: number } {
  const args: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match) {
      args[match[1]] = match[2];
    } else if (arg.startsWith('--')) {
      args[arg.slice(2)] = 'true';
    }
  }
  return {
    tier: args.tier ? parseInt(args.tier, 10) : undefined,
    timeout: args.timeout ? parseInt(args.timeout, 10) : undefined,
    cleanup: args.cleanup === 'true',
    days: args.days ? parseInt(args.days, 10) : undefined,
  };
}

async function runCleanup(days: number): Promise<number> {
  console.log(`[scrape-tier] Cleaning up stale jobs older than ${days} days...`);
  const expired = await jobIngestionService.expireStaleJobs(days);
  console.log(`[scrape-tier] Expired ${expired} stale jobs`);
  return expired;
}

async function runTierScrape(tier: number, timeoutMs: number) {
  console.log(`[scrape-tier] Starting tier ${tier} scrape with ${timeoutMs}ms timeout...`);

  const service = new SOTAScraperService();
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    console.warn(`[scrape-tier] Tier ${tier} timeout reached (${timeoutMs}ms), aborting...`);
    controller.abort();
  }, timeoutMs);

  try {
    const result = await service.scrapeSubset(tier as 1 | 2 | 3, { signal: controller.signal });

    console.log(`[scrape-tier] Tier ${tier} complete:`, {
      companiesScraped: result.companiesScraped,
      totalJobsFound: result.totalJobsFound,
      jobsIngested: result.jobsIngested,
      errors: result.errors.length,
      duration: `${(result.duration / 1000).toFixed(1)}s`,
    });

    if (result.errors.length > 0) {
      console.warn(`[scrape-tier] Errors:`, result.errors.slice(0, 10));
    }

    // Fail (throw, so the heartbeat records 'failed' and the process exits non-zero)
    // if the scrape completely failed.
    if (!result.success && result.totalJobsFound === 0) {
      throw new Error(`Tier ${tier} scrape failed: 0 jobs found, success=false`);
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<PipelineSummary> {
  checkRequiredEnvVars();

  const { tier, timeout, cleanup, days } = parseArgs();

  if (cleanup) {
    const expired = await runCleanup(days ?? 15);
    return { status: 'ok', itemsProcessed: expired, message: `Expired ${expired} stale jobs`, stats: { mode: 'cleanup', days: days ?? 15 } };
  }

  if (!tier || ![1, 2, 3].includes(tier)) {
    console.error('Usage: npx tsx scripts/scrape-tier.ts --tier=<1|2|3> --timeout=<ms>');
    console.error('       npx tsx scripts/scrape-tier.ts --cleanup --days=15');
    process.exit(1);
  }

  const result = await runTierScrape(tier, timeout ?? 600_000);
  return {
    status: result.errors.length > 0 ? 'warning' : 'ok',
    itemsProcessed: result.jobsIngested,
    itemsFailed: result.errors.length,
    message: `tier ${tier}: ${result.jobsIngested} ingested / ${result.totalJobsFound} found, ${result.companiesScraped} companies, ${result.errors.length} errors`,
    stats: { tier, companiesScraped: result.companiesScraped, totalJobsFound: result.totalJobsFound, jobsIngested: result.jobsIngested, errors: result.errors.length },
  };
}

runAsPipeline('scrape-tier', main)
  .then(() => process.exit(0))
  .catch(error => {
    console.error('[scrape-tier] Fatal error:', error);
    process.exit(1);
  });
