// One-time backfill: recompute `trust_score` for every job_posting.
//
// Why: ingestion stores ATS rows as "ATS:greenhouse", but getSourceTrustScore()
// keyed on bare vendor names ("greenhouse"), so every ATS row missed the map and
// took `default` (50). Measured on prod: 99,339 of 100,013 live jobs sat at 50,
// including 41.9K Greenhouse and 19.7K Lever postings that should score 95.
//
// The user-visible effect was that the feed's differentiation was invisible —
// the "Live · checked" badge needs trust_score >= 90, so it rendered on 267
// jobs (0.27% of the feed). The prefix bug is fixed at the source in
// job-ingestion.service.ts; this re-derives the value for existing rows.
//
//   npx tsx scripts/backfill-trust-scores.ts           # dry run (preview only)
//   npx tsx scripts/backfill-trust-scores.ts --apply    # write the changes
//
// The UPDATE is gated on `trust_score IS DISTINCT FROM <new>` so unchanged rows
// are never rewritten. That gate is load-bearing, not a micro-optimisation:
// Postgres does not skip no-op UPDATEs, and an ungated bulk rewrite of this
// table is what previously produced ~5GB of WAL per day and filled the disk.
import 'dotenv/config';
import postgres from 'postgres';

const APPLY = process.argv.includes('--apply');

// Mirror of getSourceTrustScore() in server/services/job-ingestion.service.ts.
const TRUST: Record<string, number> = {
  greenhouse: 95, lever: 95, ashby: 95, smartrecruiters: 95, 'company-api': 95,
  workday: 90, workable: 90, recruitee: 90, breezy: 90,
  usajobs: 85, remoteok: 75, jsearch: 70, themuse: 70, arbeitnow: 65,
};
const DEFAULT_TRUST = 50;

function scoreFor(source: string | null): number {
  if (!source) return DEFAULT_TRUST;
  return TRUST[source.toLowerCase().replace(/^ats:/, '')] ?? DEFAULT_TRUST;
}

async function main() {
  const dburl = process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!dburl) throw new Error('DATABASE_URL not set');
  const sql = postgres(dburl, { max: 1, idle_timeout: 20 });

  const rows = await sql<{ source: string | null; trust_score: number | null; count: number }[]>`
    SELECT source, trust_score, COUNT(*)::int AS count
    FROM job_postings
    WHERE status = 'active'
    GROUP BY source, trust_score
    ORDER BY count DESC
  `;

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — trust_score backfill\n`);
  console.log('source'.padEnd(24), 'now'.padStart(5), '->', 'new'.padStart(4), 'rows'.padStart(8));
  let willChange = 0;
  for (const r of rows) {
    const next = scoreFor(r.source);
    const changes = next !== (r.trust_score ?? DEFAULT_TRUST);
    if (changes) willChange += r.count;
    console.log(
      String(r.source).padEnd(24),
      String(r.trust_score ?? 'null').padStart(5), '->',
      String(next).padStart(4),
      String(r.count).padStart(8),
      changes ? '  CHANGE' : '');
  }
  console.log(`\n${willChange} active rows would change.`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to write.');
    await sql.end();
    return;
  }

  const BATCH = 5000;
  let total = 0;
  for (const [key, score] of [...Object.entries(TRUST), ['__default__', DEFAULT_TRUST] as const]) {
    for (;;) {
      const match = key === '__default__'
        ? sql`LOWER(REGEXP_REPLACE(source, '^[Aa][Tt][Ss]:', '')) NOT IN ${sql(Object.keys(TRUST))} OR source IS NULL`
        : sql`LOWER(REGEXP_REPLACE(source, '^[Aa][Tt][Ss]:', '')) = ${key}`;

      const updated = await sql`
        UPDATE job_postings SET trust_score = ${score}
        WHERE id IN (
          SELECT id FROM job_postings
          WHERE (${match})
            AND trust_score IS DISTINCT FROM ${score}
          LIMIT ${BATCH}
        )
        RETURNING id
      `;
      if (updated.length === 0) break;
      total += updated.length;
      console.log(`  ${key}: +${updated.length} (${total} total)`);
      await new Promise(r => setTimeout(r, 250)); // let WAL archiving keep up
    }
  }

  console.log(`\nDone — ${total} rows updated.`);
  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
