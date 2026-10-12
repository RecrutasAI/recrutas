/**
 * Close SmartRecruiters jobs the employer has taken down, confirmed by SmartRecruiters itself.
 *
 * Our board read takes the first page of each company (100 jobs, in an order that changes),
 * so most SmartRecruiters jobs are not re-seen on a run and snapshot expiry can't judge them
 * (20,192 of 33,122 live jobs unseen for 2+ days, 2026-10-12; a third of a sample were already
 * closed). This asks SmartRecruiters about each one directly, oldest-checked first:
 *   - the posting is active → it is live: refresh its liveness check;
 *   - the posting is inactive, or 404 → the employer took it down: close it.
 * Any other answer (rate limit, network) changes nothing.
 *
 *   npx tsx scripts/check-smartrecruiters-liveness.ts [--limit=3000] [--dry-run]
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm/sql';
import { db, client } from '../server/db.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';

const dryRun = process.argv.includes('--dry-run');
const LIMIT = Number((process.argv.find(a => a.startsWith('--limit=')) ?? '--limit=3000').split('=')[1]);
const CONC = 6;
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

async function state(company: string, id: string): Promise<'live' | 'gone' | 'unknown'> {
  try {
    const r = await fetch(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${encodeURIComponent(id)}`,
      { headers: { Accept: 'application/json', 'User-Agent': 'RecrutasJobAggregator/1.0' }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) {return 'gone';}
    if (!r.ok) {return 'unknown';}
    const d = await r.json() as { active?: boolean };
    return d.active === false ? 'gone' : d.active === true ? 'live' : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<PipelineSummary> {
  const jobs = rows(await db.execute(sql`
    SELECT id, external_url FROM job_postings
    WHERE status = 'active' AND source = 'ATS:smartrecruiters'
      AND (last_liveness_check IS NULL OR last_liveness_check < NOW() - INTERVAL '1 day')
    ORDER BY last_liveness_check NULLS FIRST LIMIT ${LIMIT}`));
  const live: number[] = [], gone: number[] = [];
  let unknown = 0;
  for (let i = 0; i < jobs.length; i += CONC) {
    await Promise.all(jobs.slice(i, i + CONC).map(async j => {
      const m = /smartrecruiters\.com\/([^/]+)\/(\d+)/.exec(j.external_url ?? '');
      if (!m) { unknown++; return; }
      const s = await state(m[1], m[2]);
      if (s === 'live') {live.push(j.id);} else if (s === 'gone') {gone.push(j.id);} else {unknown++;}
    }));
  }
  if (!dryRun) {
    if (live.length) {await db.execute(sql`UPDATE job_postings SET liveness_status = 'active', last_liveness_check = NOW() WHERE id IN ${live}`);}
    if (gone.length) {await db.execute(sql`UPDATE job_postings SET status = 'closed', liveness_status = 'removed', updated_at = NOW() WHERE id IN ${gone} AND status = 'active'`);}
  }
  const msg = `${jobs.length} checked: ${live.length} live, ${gone.length} closed by the employer, ${unknown} unknown${dryRun ? ' (dry run)' : ''}`;
  console.log(`[SRLiveness] ${msg}`);
  return { status: 'ok', itemsProcessed: jobs.length, message: msg, stats: { live: live.length, closed: gone.length, unknown } };
}

const finish = (code: number) => { client?.end(); process.exit(code); };
(dryRun ? main() : runAsPipeline('check-smartrecruiters-liveness', main))
  .then(() => finish(0))
  .catch(err => { console.error('[SRLiveness] Fatal:', err); finish(1); });
