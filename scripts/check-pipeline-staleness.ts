/**
 * Fails (and so alerts through run-cron.sh → alert.sh) when any scheduled job has stopped
 * running: a pipeline whose last run is older than its expected cadence (PIPELINE_MAX_AGE_MIN).
 *
 * Failures already alert; a job that silently doesn't run did not. 2026-10-13 the daily
 * third-party import was skipped by the "Pause background jobs" switch and stayed stale for a
 * day with nothing but a "stale" badge in the admin console, which nobody watches.
 *
 *   npx tsx scripts/check-pipeline-staleness.ts
 */
import 'dotenv/config';
import { client } from '../server/db.js';
import { getPipelineHealth } from '../server/services/pipeline-run.service.js';

async function main(): Promise<number> {
  const health = await getPipelineHealth();
  const late = health.filter(p => p.status === 'stale' || p.status === 'never');
  for (const p of late) {
    console.log(`[staleness] ${p.pipeline}: ${p.status}, last run ${p.lastRunAt ?? 'never'}, expected within ${p.expectedMaxAgeMinutes ?? '?'} min`);
  }
  console.log(`[staleness] ${health.length} pipelines checked, ${late.length} not running on time`);
  return late.length ? 1 : 0;
}

main()
  .then(code => { client?.end(); process.exit(code); })
  .catch(err => { console.error('[staleness] Fatal:', err); client?.end(); process.exit(1); });
