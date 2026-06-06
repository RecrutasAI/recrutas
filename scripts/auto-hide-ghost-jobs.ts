/**
 * Auto-hide stale internal jobs — standalone cron script
 * Closes platform jobs with no applicant activity after N days.
 *
 * Usage: npx tsx scripts/auto-hide-ghost-jobs.ts [--staleDays=30]
 */

import { storage } from '../server/storage.js';
import { client } from '../server/db.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';

function parseStaleDays(): number {
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--staleDays=(\d+)$/);
    if (match) return Math.max(7, Math.min(365, parseInt(match[1], 10)));
  }
  return 30;
}

async function main(): Promise<PipelineSummary> {
  const staleDays = parseStaleDays();
  console.log(`[Ghost Auto-Hide] Looking for jobs stale for ${staleDays}+ days...`);

  const staleJobs = await storage.getStaleInternalJobs(staleDays);
  if (staleJobs.length === 0) {
    console.log('[Ghost Auto-Hide] No stale jobs found');
    return { status: 'ok', itemsProcessed: 0, message: `no jobs stale for ${staleDays}+ days` };
  }

  const ids = staleJobs.map((j: any) => j.id);
  const closed = await storage.closeJobsByIds(ids);

  console.log(`[Ghost Auto-Hide] Closed ${closed} stale jobs:`);
  for (const j of staleJobs) {
    console.log(`  - ${(j as any).title} @ ${(j as any).company} (id:${(j as any).id})`);
  }
  return { status: 'ok', itemsProcessed: closed, message: `closed ${closed} jobs stale for ${staleDays}+ days` };
}

runAsPipeline('auto-hide-ghost-jobs', main)
  .then(() => { client?.end(); process.exit(0); })
  .catch((err) => { console.error('[Ghost Auto-Hide] Fatal:', err); client?.end(); process.exit(1); });
