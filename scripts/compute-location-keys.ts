/**
 * Resolve live jobs' locations to place keys (shared/places.ts) into job_postings.location_keys,
 * which the location filter matches on. New jobs get keys when saved; this fills the rest and,
 * with --recompute, re-reads every live job after the place list or the rules change. Only rows
 * whose keys differ are written (an UPDATE to the same value still writes a row version).
 *
 *   npx tsx scripts/compute-location-keys.ts               # jobs without keys (cron)
 *   npx tsx scripts/compute-location-keys.ts --recompute   # every live job
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm/sql';
import { db, client } from '../server/db.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';
import { keysForLocation } from '../server/lib/place-index.js';

const BATCH = 2000;
const MAX_MS = 25 * 60 * 1000;
const recompute = process.argv.includes('--recompute');
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

async function main(): Promise<PipelineSummary> {
  if (!keysForLocation('Seattle, WA')) {throw new Error('place list (client/public/us-places.json) not found');}
  const started = Date.now();
  let read = 0, written = 0, lastId = 0, withPlace = 0;
  const pending = recompute ? sql`TRUE` : sql`location_keys IS NULL`;
  while (Date.now() - started < MAX_MS) {
    const batch = rows(await db.execute(sql`
      SELECT id, location FROM job_postings
      WHERE status = 'active' AND id > ${lastId} AND ${pending}
      ORDER BY id LIMIT ${BATCH}`));
    if (!batch.length) {break;}
    lastId = batch[batch.length - 1].id;
    const values = batch.map(b => {
      const keys = keysForLocation(b.location) ?? [];
      if (keys.some(k => !k.startsWith('state|') && k !== 'remote')) {withPlace++;}
      return sql`(${b.id}::int, ${`{${keys.map(k => `"${k.replace(/"/g, '')}"`).join(',')}}`}::text[])`;
    });
    const res: any = await db.execute(sql`
      UPDATE job_postings j SET location_keys = v.keys
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, keys)
      WHERE j.id = v.id AND j.location_keys IS DISTINCT FROM v.keys`);
    written += Number(res?.count ?? res?.rowCount ?? 0);
    read += batch.length;
    if (read % 20000 < BATCH) {console.log(`[LocationKeys] ${read} read, ${written} written`);}
  }
  const msg = `${read} read, ${written} written, ${withPlace} resolved to a city`;
  console.log(`[LocationKeys] ${msg} in ${Math.round((Date.now() - started) / 1000)}s`);
  return { status: 'ok', itemsProcessed: read, message: msg, stats: { read, written, withPlace } };
}

const finish = (code: number) => { client?.end(); process.exit(code); };
runAsPipeline('compute-location-keys', main)
  .then(() => finish(0))
  .catch(err => { console.error('[LocationKeys] Fatal:', err); finish(1); });
