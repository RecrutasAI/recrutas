// One-time backfill: recompute `work_type` for every job_posting through the
// canonical classifyWorkType() so the feed's work-type filter is exact.
//
// Historical rows were set by ~20 inconsistent ingestion heuristics (loose
// description scans + hardcoded 'hybrid' defaults), so onsite roles showed up as
// remote/hybrid. This re-derives the value from the location-dominant classifier
// that ingestion now also uses, keeping one source of truth.
//
//   npx tsx scripts/backfill-work-type.ts          # dry run (preview only)
//   npx tsx scripts/backfill-work-type.ts --apply   # write the changes
import 'dotenv/config';
import postgres from 'postgres';
import { classifyWorkType, type CanonicalWorkType } from '../server/lib/work-type';

const APPLY = process.argv.includes('--apply');

async function main() {
  const dburl = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!dburl) throw new Error('POSTGRES_URL not set');
  const sql = postgres(dburl, { max: 1, idle_timeout: 20 });

  const [{ count }] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM job_postings`;
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${count} job_postings\n`);

  const BATCH = 2000;
  let offset = 0;
  let changed = 0;
  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  const transitions: Record<string, number> = {};

  while (offset < count) {
    // Deliberately NOT selecting `description` — location is the dominant signal
    // and pulling 130K descriptions over the pooler is far too slow. Rows that
    // would only be decided by description fall through to the onsite default,
    // which is the intended bias (stop over-calling remote/hybrid).
    const rows = await sql<{ id: number; location: string | null; title: string | null; work_type: string | null }[]>`
      SELECT id, location, title, work_type
      FROM job_postings
      ORDER BY id
      LIMIT ${BATCH} OFFSET ${offset}
    `;
    if (rows.length === 0) break;

    const updates: { id: number; wt: CanonicalWorkType }[] = [];
    for (const r of rows) {
      const old = (r.work_type || 'null').toLowerCase();
      before[old] = (before[old] || 0) + 1;
      const wt = classifyWorkType({ location: r.location, title: r.title });
      after[wt] = (after[wt] || 0) + 1;
      if (wt !== r.work_type) {
        changed++;
        transitions[`${old} → ${wt}`] = (transitions[`${old} → ${wt}`] || 0) + 1;
        updates.push({ id: r.id, wt });
      }
    }

    if (APPLY && updates.length > 0) {
      // One round-trip per chunk via parallel arrays + unnest.
      const ids = updates.map(u => u.id);
      const wts = updates.map(u => u.wt);
      await sql`
        UPDATE job_postings AS jp
        SET work_type = v.wt, updated_at = NOW()
        FROM (
          SELECT unnest(${sql.array(ids)}::int[]) AS id,
                 unnest(${sql.array(wts)}::text[]) AS wt
        ) AS v
        WHERE jp.id = v.id
      `;
    }

    offset += BATCH;
    console.log(`${Math.min(offset, count)}/${count} | changed so far: ${changed}`);
  }

  const fmt = (o: Record<string, number>) =>
    Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k.padEnd(10)} ${v}`).join('\n');

  console.log(`\n=== BEFORE (stored work_type) ===\n${fmt(before)}`);
  console.log(`\n=== AFTER (classifier) ===\n${fmt(after)}`);
  console.log(`\n=== TOP TRANSITIONS ===\n${Object.entries(transitions).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `  ${k.padEnd(22)} ${v}`).join('\n')}`);
  console.log(`\n${changed} rows ${APPLY ? 'UPDATED' : 'would change'} (${((changed / count) * 100).toFixed(1)}%).`);
  if (!APPLY) console.log('Re-run with --apply to write.');

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
