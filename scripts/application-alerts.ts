/**
 * Tell candidates when a job they applied to was taken down or reposted.
 * See server/services/application-alerts.service.ts.
 *
 *   npx tsx scripts/application-alerts.ts           # dry run: lists what would be sent
 *   npx tsx scripts/application-alerts.ts --apply   # send notifications + emails (cron)
 */
import 'dotenv/config';
import { client } from '../server/db.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';
import { runApplicationAlerts, findClosedApplications, findRepostedApplications, alertText } from '../server/services/application-alerts.service.js';

const apply = process.argv.includes('--apply');

async function main(): Promise<PipelineSummary> {
  if (!apply) {
    for (const a of [...await findRepostedApplications(20), ...await findClosedApplications(20)]) {
      console.log(`  [${a.kind}] application ${a.applicationId}: ${alertText(a).title}`);
    }
  }
  const stats = await runApplicationAlerts({ apply, log: console.log });
  console.log(`[ApplicationAlerts] ${apply ? 'sent' : 'dry run'}: ${JSON.stringify(stats)}`);
  return {
    status: 'ok',
    itemsProcessed: stats.closed + stats.reposted,
    message: `${stats.closed} closed, ${stats.reposted} reposted, ${stats.emailed} emailed`,
    stats: { ...stats },
  };
}

if (apply) {
  runAsPipeline('application-alerts', main)
    .then(() => { client?.end(); process.exit(0); })
    .catch((err) => { console.error('[ApplicationAlerts] Fatal:', err); client?.end(); process.exit(1); });
} else {
  main().then(() => { client?.end(); process.exit(0); })
    .catch((err) => { console.error('[ApplicationAlerts] Fatal:', err); client?.end(); process.exit(1); });
}
