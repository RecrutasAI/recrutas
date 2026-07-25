/**
 * Database capacity guardrail.
 *
 * Time-based purge (scripts/purge-old-jobs.ts) can't react to a burst — e.g. a
 * single scraper run once ingested 33,926 rows in a day, well under any
 * retention cutoff. This is a cheap pre-write check so ingestion stops itself
 * before the DB hits a hard provider quota, instead of finding out via a 402.
 *
 * DB_SOFT_LIMIT_BYTES defaults to a Supabase-Free-safe threshold; raise it (or
 * unset to effectively disable) once the DB is no longer quota-constrained.
 */
import { db } from '../db.js';
import { sql } from 'drizzle-orm/sql';

const DEFAULT_SOFT_LIMIT_BYTES = 460 * 1024 * 1024; // 460MB — safety margin under Supabase Free's 500MB cap

export function getSoftLimitBytes(): number {
  const raw = process.env.DB_SOFT_LIMIT_BYTES;
  if (!raw) return DEFAULT_SOFT_LIMIT_BYTES;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SOFT_LIMIT_BYTES;
}

export async function getDatabaseSizeBytes(): Promise<number> {
  const result = await db.execute(sql`SELECT pg_database_size(current_database()) AS size`);
  const rows = (result as any).rows ?? (result as any);
  return Number(rows[0]?.size ?? 0);
}

/**
 * Returns { blocked: true, sizeBytes, limitBytes } when the DB is at/over the
 * soft limit. Fails open (blocked: false) on query error — a broken capacity
 * check must never itself take down ingestion.
 */
export async function checkDbCapacity(): Promise<{ blocked: boolean; sizeBytes: number; limitBytes: number }> {
  const limitBytes = getSoftLimitBytes();
  try {
    const sizeBytes = await getDatabaseSizeBytes();
    return { blocked: sizeBytes >= limitBytes, sizeBytes, limitBytes };
  } catch (err: any) {
    console.warn('[DbCapacity] Size check failed, failing open:', err?.message);
    return { blocked: false, sizeBytes: 0, limitBytes };
  }
}
