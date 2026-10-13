/**
 * Weekly numbers (gtm-plan A4). See server/services/weekly-numbers.service.ts.
 *
 *   npx tsx scripts/weekly-numbers.ts                 # print the markdown
 *   npx tsx scripts/weekly-numbers.ts --json          # print the JSON
 *   npx tsx scripts/weekly-numbers.ts --out <dir>     # cron: write <date>.md/.json + latest.md/.json
 *
 * The VPS cron writes to /opt/recrutas/reports/weekly every Monday; the GTM agent reads
 * latest.md for its Monday [REPORT]. Nothing is emailed from here.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { client } from '../server/db.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';
import { collectWeeklyNumbers, weeklyMarkdown } from '../server/services/weekly-numbers.service.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const outDir = arg('--out');

async function main(): Promise<PipelineSummary> {
  const w = await collectWeeklyNumbers();
  const md = weeklyMarkdown(w);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    const day = w.generatedAt.slice(0, 10);
    for (const name of [day, 'latest']) {
      writeFileSync(join(outDir, `${name}.md`), md);
      writeFileSync(join(outDir, `${name}.json`), JSON.stringify(w, null, 2));
    }
    console.log(`[WeeklyNumbers] wrote ${join(outDir, `${day}.md`)}`);
  }
  console.log(process.argv.includes('--json') ? JSON.stringify(w, null, 2) : md);
  const posthogMissing = !w.activation.last7 || !w.activation.last30;
  return {
    status: posthogMissing ? 'warning' : 'ok',
    itemsProcessed: w.signups.thisWeek,
    message: `${w.signups.thisWeek} sign-ups this week${posthogMissing ? '; activation not available (PostHog)' : ''}`,
    stats: { signups: w.signups, channels: w.channels.length },
  };
}

const done = (code: number) => { client?.end(); process.exit(code); };
(outDir ? runAsPipeline('weekly-numbers', main) : main())
  .then(() => done(0))
  .catch((err) => { console.error('[WeeklyNumbers] Fatal:', err); done(1); });
