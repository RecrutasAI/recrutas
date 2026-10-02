// One-time cleanup: collapse ATS postings stored more than once because their
// URL changed.
//
// Why: scraped ATS jobs were keyed on URL, so when a board moved to a custom
// careers domain every posting was inserted again. Measured on prod 2026-10-02:
// ionq's 121 openings were active three times (job-boards.greenhouse.io/…,
// ionq.com/job?gh_jid=…, ionq.com/jobs/…?gh_jid=…) and coursera's twice — 271
// extra active rows — plus 1,514 groups of closed duplicates. Ingestion now
// keys on the vendor job id (server/lib/ats-job-key.ts); this fixes the rows
// written before that.
//
// For each (source, company, vendor job id) held by more than one row:
//   keeper  = an active row if there is one, then the most recently seen, then
//             the newest. It gets the new key as external_id, so the next
//             scrape matches it — and can't adopt one of the extras instead.
//   extras  = closed (liveness 'removed'), and their external_url cleared so
//             the keeper can take over whatever URL the board lists now. Their
//             original URL stays in external_id (the old key was the URL).
// Every write is gated so a re-run changes nothing.
//
// Checked before writing: no saved_jobs / job_applications / hidden_jobs /
// job_matches row referenced any duplicate on 2026-10-02. The script re-checks
// and refuses to touch an extra that someone has saved, applied to or hidden.
//
//   npx tsx scripts/collapse-ats-duplicates.ts           # dry run (preview only)
//   npx tsx scripts/collapse-ats-duplicates.ts --apply   # write, in one transaction
import 'dotenv/config';
import postgres from 'postgres';
import { atsJobKey, vendorJobId } from '../server/lib/ats-job-key';

const APPLY = process.argv.includes('--apply');

interface Row {
  id: number;
  source: string;
  company: string;
  status: string;
  external_id: string;
  external_url: string | null;
  last_seen: Date | null;
}

async function main(): Promise<void> {
  const dburl = process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!dburl) {throw new Error('DATABASE_URL not set');}
  const sql = postgres(dburl, { max: 1 });

  try {
    const rows = await sql<Row[]>`
      SELECT id, source, company, status, external_id, external_url,
             COALESCE(last_liveness_check, created_at) AS last_seen
      FROM job_postings
      WHERE source LIKE 'ATS:%' AND external_url IS NOT NULL
    `;

    const groups = new Map<string, Row[]>();
    let unparsed = 0;
    for (const r of rows) {
      const id = vendorJobId(r.source, r.external_url);
      if (!id) { unparsed++; continue; }
      const k = `${r.source}\u0000${r.company}\u0000${id}`;
      let g = groups.get(k);
      if (!g) {groups.set(k, g = []);}
      g.push(r);
    }

    const referenced = new Set<number>((await sql<{ job_id: number }[]>`
      SELECT job_id FROM saved_jobs UNION SELECT job_id FROM job_applications
      UNION SELECT job_id FROM hidden_jobs UNION SELECT job_id FROM job_matches
    `).map(r => r.job_id));

    const rekey: Array<{ id: number; key: string }> = [];
    const retire: number[] = [];
    let extraActive = 0, blocked = 0;
    const byCompany = new Map<string, number>();

    for (const g of groups.values()) {
      if (g.length < 2) {continue;}
      g.sort((a, b) =>
        Number(b.status === 'active') - Number(a.status === 'active')
        || (b.last_seen?.getTime() ?? 0) - (a.last_seen?.getTime() ?? 0)
        || b.id - a.id);
      const [keeper, ...extras] = g;
      const key = atsJobKey(keeper.source, keeper.company, keeper.external_url!);
      if (keeper.external_id !== key) {rekey.push({ id: keeper.id, key });}
      for (const e of extras) {
        if (referenced.has(e.id)) { blocked++; continue; }
        retire.push(e.id);
        if (e.status === 'active') {
          extraActive++;
          byCompany.set(`${e.source} ${e.company}`, (byCompany.get(`${e.source} ${e.company}`) ?? 0) + 1);
        }
      }
    }

    const dupGroups = [...groups.values()].filter(g => g.length > 1).length;
    console.log(`ATS rows: ${rows.length} (${unparsed} with no vendor id — left alone)`);
    console.log(`Duplicate groups: ${dupGroups}`);
    console.log(`Keepers to re-key: ${rekey.length}`);
    console.log(`Extras to retire: ${retire.length} (${extraActive} active — these leave the feed)`);
    if (blocked) {console.log(`⚠️  ${blocked} extras skipped: a user has saved, applied to or hidden them`);}
    for (const [c, n] of [...byCompany].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${c}: ${n} active duplicates`);
    }

    if (!APPLY) {
      console.log('\nDry run — nothing written. Re-run with --apply.');
      return;
    }

    await sql.begin(async tx => {
      // Extras first: they release the URLs a keeper may need next scrape.
      for (let i = 0; i < retire.length; i += 1000) {
        const ids = retire.slice(i, i + 1000);
        await tx`
          UPDATE job_postings
          SET status = 'closed', liveness_status = 'removed', external_url = NULL, updated_at = NOW()
          WHERE id IN ${tx(ids)}
            AND (status <> 'closed' OR liveness_status IS DISTINCT FROM 'removed' OR external_url IS NOT NULL)
        `;
      }
      for (const { id, key } of rekey) {
        await tx`
          UPDATE job_postings AS jp SET external_id = ${key}, updated_at = NOW()
          WHERE jp.id = ${id} AND jp.external_id IS DISTINCT FROM ${key}
            AND NOT EXISTS (SELECT 1 FROM job_postings x
                            WHERE x.source = jp.source AND x.external_id = ${key} AND x.id <> jp.id)
        `;
      }
    });
    console.log('\nApplied.');
  } finally {
    await sql.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
