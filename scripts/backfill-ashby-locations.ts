/**
 * One-off (2026-10-12): fill the location of live Ashby jobs that were stored without one.
 * The Ashby reader asked for a field Ashby doesn't have (`locationName`), so all 17,025 live
 * Ashby jobs had no location: no place filter, and foreign jobs slipped past the US-only feed.
 * Re-reads each Ashby board and writes the location only where it is empty; place keys are
 * cleared so compute-location-keys (hourly) resolves them.
 *
 *   npx tsx scripts/backfill-ashby-locations.ts [--dry-run]
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm/sql';
import { db, client } from '../server/db.js';
import { fetchAtsBoard } from '../server/lib/adzuna-link-resolver.js';

const dryRun = process.argv.includes('--dry-run');
const CONC = 8;
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

async function main(): Promise<void> {
  const boards = rows(await db.execute(sql`
    SELECT DISTINCT "atsId" AS id FROM discovered_companies WHERE "detectedAts" = 'ashby' AND status = 'approved' AND "atsId" IS NOT NULL`));
  let read = 0, failed = 0, written = 0, found = 0;
  for (let i = 0; i < boards.length; i += CONC) {
    const results = await Promise.all(boards.slice(i, i + CONC).map(b => fetchAtsBoard('ashby', b.id)));
    const pairs: Array<{ url: string; loc: string }> = [];
    for (const r of results) {
      if (!r.ok) { failed++; continue; }
      read++;
      for (const j of r.jobs) {if (j.url && j.location) {pairs.push({ url: j.url, loc: j.location });}}
    }
    found += pairs.length;
    if (!pairs.length || dryRun) {continue;}
    const values = pairs.map(p => sql`(${p.url}, ${p.loc})`);
    const res: any = await db.execute(sql`
      UPDATE job_postings j SET location = v.loc, location_keys = NULL
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(url, loc)
      WHERE j.external_url = v.url AND coalesce(trim(j.location), '') = ''`);
    written += Number(res?.count ?? res?.rowCount ?? 0);
  }
  console.log(`[AshbyLocations] boards ${boards.length}: ${read} read, ${failed} failed; ${found} jobs with a location; ${written} rows filled${dryRun ? ' (dry run)' : ''}`);
}

main().then(() => { client?.end(); process.exit(0); }).catch(err => { console.error(err); client?.end(); process.exit(1); });
