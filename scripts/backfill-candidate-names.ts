/**
 * One-time: fill blank candidate names from the account row, sign-in metadata
 * (incl. Google's full_name) or the parsed resume. The extension names the
 * attached resume "First_Last_resume.pdf" from this; without a name, files
 * went to recruiters named after the email address. Typed names are never
 * touched. Prints counts only (no names).
 *
 *   npx tsx scripts/backfill-candidate-names.ts           # dry run
 *   npx tsx scripts/backfill-candidate-names.ts --apply   # write; changed ids saved for rollback
 *
 * Rollback: UPDATE candidate_users SET first_name = NULL, last_name = NULL
 *           WHERE user_id = ANY(<ids from the saved file>);
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { sql } from 'drizzle-orm/sql';
import { db, client } from '../server/db.js';
import { storage } from '../server/storage.js';
import { getSupabaseAdmin } from '../server/lib/supabase-admin.js';
import { resolveCandidateName } from '../server/lib/candidate-name.js';

const apply = process.argv.includes('--apply');
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

async function main(): Promise<void> {
  const sb = getSupabaseAdmin();
  const blank = rows(await db.execute(sql`
    SELECT c.user_id, c.resume_url, u.first_name AS uf, u.last_name AS ul,
           c.resume_parsing_data->'personalInfo'->>'name' AS resume_name
    FROM candidate_users c LEFT JOIN users u ON u.id = c.user_id
    WHERE coalesce(trim(c.first_name), '') = ''`));
  const tally: Record<string, number> = {};
  const changed: string[] = [];
  let missingFiles = 0;
  for (const r of blank) {
    const { data } = await sb.auth.admin.getUserById(r.user_id);
    const md = (data?.user?.user_metadata || {}) as Record<string, unknown>;
    const name = resolveCandidateName({ user: { firstName: r.uf, lastName: r.ul }, authMetadata: md, resumeName: r.resume_name });
    const source = !name ? 'none'
      : (r.uf || '').trim() ? 'account row' : md.first_name ? 'sign-in first_name' : (md.full_name || md.name) ? 'sign-in full_name (Google)' : 'resume';
    tally[source] = (tally[source] || 0) + 1;
    if (r.resume_url && !r.resume_url.startsWith('http')) {
      const { data: info } = await sb.storage.from('resumes').info(r.resume_url).catch(() => ({ data: null }));
      if (!info) {missingFiles++;}
    }
    if (name && apply) {
      await storage.fillCandidateNameIfMissing(r.user_id, md);
      changed.push(r.user_id);
    }
  }
  console.log(`[names] blank profiles: ${blank.length}; name found from: ${JSON.stringify(tally)}`);
  console.log(`[names] blank profiles whose resume file is missing from storage: ${missingFiles}`);
  if (apply) {
    const file = `/tmp/backfill-candidate-names-${Date.now()}.json`;
    writeFileSync(file, JSON.stringify(changed));
    console.log(`[names] updated ${changed.length}; ids saved to ${file} for rollback`);
  } else {
    console.log('[names] dry run; pass --apply to write');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => client.end?.());
