/**
 * Purge old external jobs — standalone cron script
 * Deletes external jobs older than N days to prevent unbounded table growth.
 *
 * Usage: npx tsx scripts/purge-old-jobs.ts [--retainDays=90]
 */

import { db, client } from '../server/db.js';
import { sql } from 'drizzle-orm/sql';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';

function parseRetainDays(): number {
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--retainDays=(\d+)$/);
    if (match) return Math.max(30, Math.min(365, parseInt(match[1], 10)));
  }
  return 90;
}

async function main(): Promise<PipelineSummary> {
  if (!db) { console.error('[Purge] Database not available'); process.exit(1); }

  const retainDays = parseRetainDays();
  console.log(`[Purge] Deleting external jobs older than ${retainDays} days...`);

  const candidates = await db.execute(sql`
    SELECT jp.id FROM job_postings jp
    WHERE (jp.source != 'platform' OR jp.source IS NULL)
      AND jp.external_url IS NOT NULL
      AND jp.created_at < NOW() - (${retainDays} || ' days')::interval
  `);
  const candidateIds = ((candidates as any).rows ?? (candidates as any)).map((r: any) => r.id);

  if (candidateIds.length === 0) {
    console.log(`[Purge] No jobs to purge (retainDays=${retainDays})`);
    return { status: 'ok', itemsProcessed: 0, message: `no jobs older than ${retainDays} days` };
  }

  const idList = candidateIds.join(',');

  // 1. Delete notifications that reference applications for these jobs (FK: related_application_id → job_applications.id)
  await db.execute(sql.raw(`DELETE FROM notifications WHERE related_application_id IN (SELECT id FROM job_applications WHERE job_id IN (${idList}))`));
  // 2. Delete notifications that reference these jobs directly
  await db.execute(sql.raw(`DELETE FROM notifications WHERE related_job_id IN (${idList})`));
  // 3. Now safe to delete remaining dependent tables
  for (const table of ['job_applications', 'job_matches', 'exam_attempts', 'job_exams', 'chat_rooms', 'interviews', 'saved_jobs', 'hidden_jobs']) {
    await db.execute(sql.raw(`DELETE FROM ${table} WHERE job_id IN (${idList})`));
  }
  const result = await db.execute(sql.raw(`DELETE FROM job_postings WHERE id IN (${candidateIds.join(',')}) RETURNING id`));
  const deleted = ((result as any).rows ?? (result as any)).length;
  console.log(`[Purge] Deleted ${deleted} external jobs older than ${retainDays} days`);
  return { status: 'ok', itemsProcessed: deleted, message: `deleted ${deleted} external jobs older than ${retainDays} days` };
}

runAsPipeline('purge-old-jobs', main)
  .then(() => { client?.end(); process.exit(0); })
  .catch((err) => { console.error('[Purge] Fatal:', err); client?.end(); process.exit(1); });
