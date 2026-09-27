/**
 * Hard-delete external job rows that are finished with.
 *
 * This used to delete every external row created more than N days ago, in any
 * status. A posting still live on its board was deleted along with every
 * user's application, saved-job and hidden-job row for it, and the next scrape
 * re-inserted it as a brand-new job — ~2,200 recycled postings a day
 * (measured 2026-09-25..27 in the first scrape after the 05:00Z purge).
 *
 * A row is purged now only when all of these hold:
 *  - it is closed (never an active row),
 *  - no scraper has seen it for `retainDays` (last_liveness_check, which
 *    ingestion refreshes on every sighting; created_at for never-seen rows),
 *  - no user has a record of their own against it — an application, a saved
 *    job, a chat, an interview or an exam attempt. Those rows are the user's
 *    history and outlive the posting.
 * Derived rows (matches, notifications, hidden-job flags, exam definitions)
 * are deleted with the job.
 */
import { db } from '../db';
import { sql } from 'drizzle-orm/sql';

/** Tables holding a user's own record against a job — their presence blocks a purge. */
export const USER_OWNED_JOB_TABLES = ['job_applications', 'saved_jobs', 'chat_rooms', 'interviews', 'exam_attempts'] as const;
/** Tables derived from a job, deleted along with it. */
const DERIVED_JOB_TABLES = ['job_matches', 'job_exams', 'hidden_jobs'] as const;

const CHUNK = 1000;

export async function purgeOldExternalJobs(retainDays: number): Promise<number> {
  const notOwned = USER_OWNED_JOB_TABLES
    .map(t => `AND NOT EXISTS (SELECT 1 FROM ${t} o WHERE o.job_id = jp.id)`)
    .join('\n        ');
  const candidates = await db.execute(sql`
    SELECT jp.id FROM job_postings jp
    WHERE (jp.source != 'platform' OR jp.source IS NULL)
      AND jp.external_url IS NOT NULL
      AND jp.status <> 'active'
      AND COALESCE(jp.last_liveness_check, jp.created_at) < NOW() - (${retainDays} || ' days')::interval
      ${sql.raw(notOwned)}
  `);
  const ids: number[] = ((candidates as any).rows ?? (candidates as any)).map((r: any) => r.id);

  let deleted = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const idList = ids.slice(i, i + CHUNK).join(',');
    await db.execute(sql.raw(`DELETE FROM notifications WHERE related_job_id IN (${idList})`));
    for (const table of DERIVED_JOB_TABLES) {
      await db.execute(sql.raw(`DELETE FROM ${table} WHERE job_id IN (${idList})`));
    }
    const result = await db.execute(sql.raw(`DELETE FROM job_postings WHERE id IN (${idList}) RETURNING id`));
    deleted += ((result as any).rows ?? (result as any)).length;
  }
  return deleted;
}
