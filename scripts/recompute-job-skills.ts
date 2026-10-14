/**
 * Re-read live jobs' skills with the prose-safe extractor (server/utils/skill-extractor.ts).
 *
 * The old extractors tagged everyday words as skills ('Compensation Analysis' on 42,738 jobs from
 * "compensation", 'Go' on 13,629, 'C' on 4,202, 'React Native' on nursing jobs that say "RN").
 * For each job: a stored skill that our vocabulary produces but the new rules no longer find in
 * the text is dropped; skills outside the vocabulary (from an employer's own structured data)
 * are kept; skills the new rules find are added. Rows are written only when they change.
 *
 *   npx tsx scripts/recompute-job-skills.ts            # dry run: counts and examples
 *   npx tsx scripts/recompute-job-skills.ts --apply    # write
 *   ... --from-id 123456                               # resume after that job id
 *
 * Runs alongside ingestion, which writes the same table: a write that times out (2026-10-14
 * 06:10, during the 06:00 scrape) is retried after a pause in smaller pieces, not fatal.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm/sql';
import { db, client } from '../server/db.js';
import { extractSkillsFromText, extractorVocabulary } from '../server/utils/skill-extractor.js';
import { normalizeSkills } from '../server/skill-normalizer.js';

const apply = process.argv.includes('--apply');
const fromArg = process.argv.indexOf('--from-id');
const FROM_ID = fromArg >= 0 ? Number(process.argv[fromArg + 1]) || 0 : 0;
const RETRIES = 4;
const BATCH = 1000;
const PAUSE_MS = 200;  // easy on the box: ingestion keeps running alongside

const rows = (r: any): any[] => (r?.rows ?? r) as any[];
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/** One UPDATE per slice; on an error, wait and retry in halves, up to RETRIES times. */
async function writeWithRetry(updates: Array<{ id: number; skills: string[] }>, attempt = 0): Promise<number> {
  try {
    const values = updates.map(u => sql`(${u.id}::int, ${JSON.stringify(u.skills)}::jsonb)`);
    const res: any = await db!.execute(sql`
      UPDATE job_postings j SET skills = v.skills
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, skills)
      WHERE j.id = v.id AND j.skills IS DISTINCT FROM v.skills`);
    return Number(res?.count ?? res?.rowCount ?? 0);
  } catch (err) {
    if (attempt >= RETRIES) {throw err;}
    const wait = 15_000 * (attempt + 1);
    console.warn(`[JobSkills] write failed (${(err as Error).message.slice(0, 80)}); retrying ${updates.length} rows in halves after ${wait / 1000}s`);
    await sleep(wait);
    if (updates.length === 1) {return writeWithRetry(updates, attempt + 1);}
    const mid = Math.ceil(updates.length / 2);
    return (await writeWithRetry(updates.slice(0, mid), attempt + 1)) + (await writeWithRetry(updates.slice(mid), attempt + 1));
  }
}

async function main(): Promise<void> {
  const vocab = extractorVocabulary();  // lowercase canonical names the extractor can produce
  let lastId = FROM_ID, read = 0, changed = 0, written = 0;
  const removed = new Map<string, number>(), added = new Map<string, number>();
  for (;;) {
    const batch = rows(await db!.execute(sql`
      SELECT id, title, description, skills FROM job_postings
      WHERE status = 'active' AND id > ${lastId} ORDER BY id LIMIT ${BATCH}`));
    if (!batch.length) {break;}
    lastId = batch[batch.length - 1].id;
    const updates: Array<{ id: number; skills: string[] }> = [];
    for (const job of batch) {
      read++;
      const old: string[] = Array.isArray(job.skills) ? job.skills.map(String) : [];
      const found = normalizeSkills(extractSkillsFromText(`${job.title ?? ''}\n${job.description ?? ''}`));
      const foundSet = new Set(found.map(s => s.toLowerCase()));
      const kept = old.filter(s => !vocab.has(s.toLowerCase()) || foundSet.has(s.toLowerCase()));
      const next = normalizeSkills([...kept, ...found]).slice(0, 30);
      const oldKey = JSON.stringify([...old].map(s => s.toLowerCase()).sort());
      const nextKey = JSON.stringify([...next].map(s => s.toLowerCase()).sort());
      if (oldKey === nextKey) {continue;}
      changed++;
      for (const s of old) {if (!next.some(n => n.toLowerCase() === s.toLowerCase())) {removed.set(s, (removed.get(s) ?? 0) + 1);}}
      for (const s of next) {if (!old.some(o => o.toLowerCase() === s.toLowerCase())) {added.set(s, (added.get(s) ?? 0) + 1);}}
      updates.push({ id: job.id, skills: next });
    }
    if (apply && updates.length) {written += await writeWithRetry(updates);}
    if (read % 20000 < BATCH) {console.log(`[JobSkills] ${read} read (up to id ${lastId}), ${changed} would change${apply ? `, ${written} written` : ''}`);}
    await sleep(PAUSE_MS);
  }
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`[JobSkills] ${apply ? 'applied' : 'dry run'}: ${read} live jobs read, ${changed} change${apply ? `, ${written} written` : ''}`);
  console.log(`[JobSkills] most removed: ${top(removed)}`);
  console.log(`[JobSkills] most added: ${top(added)}`);
}

main()
  .then(() => { client?.end(); process.exit(0); })
  .catch(err => { console.error('[JobSkills] Fatal:', err); client?.end(); process.exit(1); });
