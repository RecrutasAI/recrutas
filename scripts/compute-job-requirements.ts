/**
 * Read hard requirements (clearance, citizenship, sponsorship, years) for live
 * jobs that don't have them yet, into job_hard_requirements. Runs after each
 * board sweep; the first run backfills everything.
 *
 *   npx tsx scripts/compute-job-requirements.ts            # fill missing (cron)
 *   npx tsx scripts/compute-job-requirements.ts --dry-run  # count only
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm/sql';
import { db, client } from '../server/db.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';
import { extractHardRequirements } from '../server/lib/hard-requirements.js';

const BATCH = 1000;
const MAX_MS = 25 * 60 * 1000;
const dryRun = process.argv.includes('--dry-run');
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

async function main(): Promise<PipelineSummary> {
  const missing = rows(await db.execute(sql`
    SELECT count(*)::int AS n FROM job_postings j
    WHERE j.status = 'active' AND NOT EXISTS (SELECT 1 FROM job_hard_requirements r WHERE r.job_id = j.id)`))[0].n;
  console.log(`[JobRequirements] ${missing} live jobs without requirements`);
  if (dryRun) {return { status: 'ok', itemsProcessed: 0, message: `dry run: ${missing} missing` };}

  const started = Date.now();
  let done = 0, lastId = 0;
  const tally = { clearance: 0, usCitizen: 0, usPerson: 0, noSponsorship: 0, years: 0 };
  while (Date.now() - started < MAX_MS) {
    const batch = rows(await db.execute(sql`
      SELECT j.id, j.description FROM job_postings j
      WHERE j.status = 'active' AND j.id > ${lastId}
        AND NOT EXISTS (SELECT 1 FROM job_hard_requirements r WHERE r.job_id = j.id)
      ORDER BY j.id LIMIT ${BATCH}`));
    if (!batch.length) {break;}
    lastId = batch[batch.length - 1].id;
    const values = batch.map(b => {
      const r = extractHardRequirements(b.description);
      if (r.clearance) {tally.clearance++;}
      if (r.usCitizen) {tally.usCitizen++;}
      if (r.usPerson) {tally.usPerson++;}
      if (r.noSponsorship) {tally.noSponsorship++;}
      if (r.minYears != null) {tally.years++;}
      return sql`(${b.id}, ${r.clearance}, ${r.clearanceObtainable}, ${r.usCitizen}, ${r.usPerson}, ${r.noSponsorship}, ${r.minYears})`;
    });
    await db.execute(sql`
      INSERT INTO job_hard_requirements (job_id, clearance, obtainable, us_citizen, us_person, no_sponsorship, min_years)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (job_id) DO NOTHING`);
    done += batch.length;
    if (done % 10000 < BATCH) {console.log(`[JobRequirements] ${done} done`);}
  }
  console.log(`[JobRequirements] filled ${done} in ${Math.round((Date.now() - started) / 1000)}s: ${JSON.stringify(tally)}`);
  return { status: 'ok', itemsProcessed: done, message: `${done} filled`, stats: { ...tally, remaining: Math.max(0, missing - done) } };
}

const finish = (code: number) => { client?.end(); process.exit(code); };
(dryRun ? main() : runAsPipeline('compute-job-requirements', main))
  .then(() => finish(0))
  .catch(err => { console.error('[JobRequirements] Fatal:', err); finish(1); });
