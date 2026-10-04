/**
 * One-shot migration: create api_tokens (MCP connector personal access tokens).
 * Safe to run multiple times (IF NOT EXISTS). Usage: npx tsx scripts/add-api-tokens-table.ts
 */
import { readFileSync } from 'fs';
import { db, client } from '../server/db.js';
import { sql } from 'drizzle-orm/sql';

async function main() {
  const ddl = readFileSync(new URL('../migrations/add-api-tokens.sql', import.meta.url), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of ddl) {
    console.log(`[migrate] ${stmt.split('\n')[0]}...`);
    await db.execute(sql.raw(stmt));
  }
  console.log('[migrate] Done: api_tokens ready.');
}
main().then(() => { client?.end(); process.exit(0); }).catch(err => { console.error(err); client?.end(); process.exit(1); });
