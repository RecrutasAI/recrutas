/**
 * Move resumes kept in our Postgres (while Supabase Storage was unavailable) back to
 * Supabase, then point the profile at the new key and delete the Postgres copy.
 * Nothing changes for a file Supabase still refuses; the next run tries again.
 * Normally there is nothing to do.
 *
 *   npx tsx scripts/move-fallback-resumes.ts [--dry-run]
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm/sql';
import { db, client } from '../server/db.js';
import { supabaseAdmin } from '../server/lib/supabase-admin.js';
import { FALLBACK_PREFIX } from '../server/lib/resume-files.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';

const dryRun = process.argv.includes('--dry-run');
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

async function main(): Promise<PipelineSummary> {
  const files = rows(await db.execute(sql`SELECT key, content, content_type FROM resume_file_fallback ORDER BY created_at LIMIT 200`));
  let moved = 0, failed = 0;
  for (const f of files) {
    const name = String(f.key).slice(FALLBACK_PREFIX.length);
    if (dryRun) {continue;}
    const { error } = await supabaseAdmin.storage.from('resumes')
      .upload(name, Buffer.from(f.content), { contentType: f.content_type || undefined, upsert: true });
    if (error) { failed++; console.warn(`[MoveResumes] ${f.key}: Supabase still refuses (${error.message})`); continue; }
    await db.transaction(async tx => {
      await tx.execute(sql`UPDATE candidate_users SET resume_url = ${name} WHERE resume_url = ${f.key}`);
      await tx.execute(sql`DELETE FROM resume_file_fallback WHERE key = ${f.key}`);
    });
    moved++;
  }
  const msg = `${files.length} waiting: ${moved} moved to Supabase, ${failed} still waiting${dryRun ? ' (dry run)' : ''}`;
  console.log(`[MoveResumes] ${msg}`);
  return { status: failed ? 'warning' : 'ok', itemsProcessed: files.length, message: msg, stats: { moved, failed } };
}

const finish = (code: number) => { client?.end(); process.exit(code); };
(dryRun ? main() : runAsPipeline('move-fallback-resumes', main))
  .then(() => finish(0))
  .catch(err => { console.error('[MoveResumes] Fatal:', err); finish(1); });
