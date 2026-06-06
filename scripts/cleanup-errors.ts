/**
 * Cleanup old observability rows — standalone cron script
 * Deletes error_events and pipeline_runs older than 30 days.
 *
 * Usage: npx tsx scripts/cleanup-errors.ts
 */

import { db, client } from '../server/db.js';
import { sql } from 'drizzle-orm/sql';

async function main() {
  if (!db) { console.error('[ErrorCleanup] Database not available'); process.exit(1); }

  console.log('[ErrorCleanup] Deleting error events older than 30 days...');
  const errResult = await db.execute(sql`
    DELETE FROM error_events WHERE created_at < NOW() - INTERVAL '30 days' RETURNING id
  `);
  console.log(`[ErrorCleanup] Deleted ${((errResult as any).rows ?? (errResult as any)).length} error events`);

  console.log('[ErrorCleanup] Deleting pipeline runs older than 30 days...');
  const runResult = await db.execute(sql`
    DELETE FROM pipeline_runs WHERE created_at < NOW() - INTERVAL '30 days' RETURNING id
  `);
  console.log(`[ErrorCleanup] Deleted ${((runResult as any).rows ?? (runResult as any)).length} pipeline runs`);
}

main()
  .then(() => { client?.end(); process.exit(0); })
  .catch((err) => { console.error('[ErrorCleanup] Fatal:', err); client?.end(); process.exit(1); });
