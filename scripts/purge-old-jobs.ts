/**
 * Purge old external jobs — standalone cron script
 * Deletes closed external jobs no scraper has seen for N days, keeping any a
 * user applied to, saved or chatted about. See server/services/job-purge.service.ts.
 *
 * Usage: npx tsx scripts/purge-old-jobs.ts [--retainDays=90]
 */

import { db, client } from '../server/db.js';
import { purgeOldExternalJobs } from '../server/services/job-purge.service.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';

function parseRetainDays(): number {
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--retainDays=(\d+)$/);
    if (match) return Math.max(30, Math.min(365, parseInt(match[1], 10)));
  }
  return 90;
}

async function main(): Promise<PipelineSummary> {
  if (!db) { console.error('[Purge] Database not available'); process.exit(1); }
  const retainDays = parseRetainDays();
  console.log(`[Purge] Deleting closed external jobs unseen for ${retainDays}+ days...`);
  const deleted = await purgeOldExternalJobs(retainDays);
  console.log(`[Purge] Deleted ${deleted} closed external jobs unseen for ${retainDays}+ days`);
  return { status: 'ok', itemsProcessed: deleted, message: `deleted ${deleted} closed external jobs unseen for ${retainDays}+ days` };
}

runAsPipeline('purge-old-jobs', main)
  .then(() => { client?.end(); process.exit(0); })
  .catch((err) => { console.error('[Purge] Fatal:', err); client?.end(); process.exit(1); });
