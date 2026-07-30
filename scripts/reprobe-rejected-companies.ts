/**
 * Re-queue rejected companies for probing.
 *
 * The `rejected` pool is contaminated. Until 2026-07-30 a company was written
 * `status='rejected'` whenever probeCompany returned no ATS — but "no ATS" was
 * indistinguishable from two failure modes:
 *
 *   1. A 429 from any provider returned `false`, same as a clean miss.
 *   2. The Greenhouse probe pointed at boards.greenhouse.io, which 301s for
 *      every slug and then hits bot protection (measured: 403/406 on every
 *      request, zero 200s). Greenhouse is our highest-yield source, so *every*
 *      Greenhouse company that came through the probe was rejected.
 *
 * Both are fixed, so these rows deserve a second look. Resetting them to
 * `pending` with lastProbedAt = NULL puts them in the never-probed bucket,
 * which is accurate: they have never been probed by code that could succeed.
 *
 * Usage:
 *   npx tsx scripts/reprobe-rejected-companies.ts --dry-run
 *   npx tsx scripts/reprobe-rejected-companies.ts [--limit=N]
 */
import dotenv from 'dotenv';
dotenv.config();

import { db } from '../server/db.js';
import { discoveredCompanies } from '../shared/schema.js';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm/sql';

async function main() {
  if (!db) throw new Error('DB not available');

  const dryRun = process.argv.includes('--dry-run');
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;

  const [{ count: rejectedCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(discoveredCompanies)
    .where(eq(discoveredCompanies.status, 'rejected'));

  console.log(`[ReprobeRejected] ${rejectedCount} companies currently rejected`);

  if (dryRun) {
    console.log('[ReprobeRejected] --dry-run: no changes written');
    process.exit(0);
  }

  // Reset to pending as never-probed so they interleave with fresh discoveries
  // rather than jumping the queue ahead of everything else.
  const where = limit
    ? sql`status = 'rejected' AND id IN (
        SELECT id FROM discovered_companies WHERE status = 'rejected' ORDER BY id LIMIT ${limit}
      )`
    : sql`status = 'rejected'`;

  const res = await db.execute(sql`
    UPDATE discovered_companies
       SET status = 'pending', "lastProbedAt" = NULL, "updatedAt" = now()
     WHERE ${where}
  `);

  console.log(`[ReprobeRejected] Re-queued ${(res as any).rowCount ?? 'unknown'} companies as pending`);
  process.exit(0);
}

main().catch(err => {
  console.error('[ReprobeRejected] Failed:', err);
  process.exit(1);
});
