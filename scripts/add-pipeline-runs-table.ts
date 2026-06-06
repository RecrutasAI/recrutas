/**
 * One-shot migration: create the pipeline_runs heartbeat table (cron observability).
 * Safe to run multiple times (IF NOT EXISTS).
 *
 * Usage: npx tsx scripts/add-pipeline-runs-table.ts
 */

import { db } from '../server/db.js';
import { sql } from 'drizzle-orm/sql';

const migrations = [
  `CREATE TABLE IF NOT EXISTS pipeline_runs (
     id              SERIAL PRIMARY KEY,
     pipeline        VARCHAR(80) NOT NULL,
     status          VARCHAR(16) NOT NULL,
     started_at      TIMESTAMP NOT NULL,
     finished_at     TIMESTAMP DEFAULT NOW(),
     duration_ms     INTEGER,
     items_processed INTEGER DEFAULT 0,
     items_failed    INTEGER DEFAULT 0,
     message         TEXT,
     stats           JSONB,
     created_at      TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_latest ON pipeline_runs (pipeline, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_created_at ON pipeline_runs (created_at)`,
];

async function main() {
  if (!db) { console.error('[migrate] Database not available'); process.exit(1); }

  for (const ddl of migrations) {
    console.log(`[migrate] ${ddl.split('\n')[0]}...`);
    await db.execute(sql.raw(ddl));
  }

  console.log('[migrate] Done — pipeline_runs table ready.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('[migrate] Fatal:', err); process.exit(1); });
