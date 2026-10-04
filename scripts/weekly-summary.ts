/**
 * Weekly summary email for active candidates. See server/services/weekly-summary.service.ts.
 *
 *   npx tsx scripts/weekly-summary.ts           # dry run: who would get what
 *   npx tsx scripts/weekly-summary.ts --apply   # send (cron, Mondays)
 */
import 'dotenv/config';
import { client } from '../server/db.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';
import { runWeeklySummaries } from '../server/services/weekly-summary.service.js';

const apply = process.argv.includes('--apply');

async function main(): Promise<PipelineSummary> {
  // The feed logs heavily; keep the report readable.
  const log = console.log;
  console.log = (...a: unknown[]) => { if (String(a[0]).startsWith('[WeeklySummary]')) {log(...a);} };
  const stats = await runWeeklySummaries({ apply, log: console.log });
  console.log = log;
  console.log(`[WeeklySummary] ${apply ? 'sent' : 'dry run'}: ${JSON.stringify(stats)}`);
  return {
    status: stats.failed ? 'warning' : 'ok',
    itemsProcessed: stats.sent,
    itemsFailed: stats.failed,
    message: `${stats.considered} considered, ${stats.sent} sent, ${stats.skippedNoNews} had no news`,
    stats: { ...stats },
  };
}

const done = (code: number) => { client?.end(); process.exit(code); };
(apply ? runAsPipeline('weekly-summary', main) : main())
  .then(() => done(0))
  .catch((err) => { console.error('[WeeklySummary] Fatal:', err); done(1); });
