/**
 * Bulk writes to job_postings in chunks sized by time, not by a fixed row count.
 *
 * Why (2026-10-15): three cron jobs (check-smartrecruiters-liveness, compute-location-keys,
 * recompute-job-skills) failed five times in a week with "canceling statement due to statement
 * timeout". Each UPDATE that changes an indexed column can't be a HOT update, so every row also
 * rewrites all of job_postings' indexes, the HNSW vector index included: measured at ~23 ms per
 * row (300 rows: 6.8 s). The app's statement_timeout is 20 s (server/db.ts), so any write of more
 * than ~850 rows fails, and fixed batch sizes of 1,000–3,000 did whenever many rows changed.
 *
 * So each chunk is timed, and the next one is sized to take about `targetMs`; a chunk that still
 * times out is retried at a quarter of its size. One slow day can't fail the whole run.
 */
export interface ChunkedWriteOptions {
  targetMs?: number;   // aim per chunk; well under the 20 s statement timeout
  start?: number;      // first chunk size, before anything is measured
  min?: number;        // give up (rethrow) if even this many rows time out
  max?: number;
}

export function isStatementTimeout(err: unknown): boolean {
  for (let e: any = err; e; e = e.cause) {
    if (e.code === '57014' || /statement timeout/i.test(String(e.message ?? ''))) {return true;}
  }
  return false;
}

/** Writes `items` with `write(chunk)` (which returns rows changed); returns the total changed. */
export async function writeInChunks<T>(
  items: readonly T[],
  write: (chunk: T[]) => Promise<number>,
  { targetMs = 5_000, start = 200, min = 5, max = 2_000 }: ChunkedWriteOptions = {},
  now: () => number = Date.now,
): Promise<number> {
  let size = Math.max(min, Math.min(start, max));
  let written = 0;
  for (let i = 0; i < items.length;) {
    const chunk = items.slice(i, i + size);
    const t0 = now();
    try {
      written += await write(chunk);
    } catch (err) {
      if (!isStatementTimeout(err) || chunk.length <= min) {throw err;}
      size = Math.max(min, Math.floor(chunk.length / 4));
      console.warn(`[chunked-write] ${chunk.length} rows timed out; retrying in chunks of ${size}`);
      continue;
    }
    i += chunk.length;
    const perRow = Math.max(0.01, (now() - t0) / chunk.length);
    size = Math.max(min, Math.min(max, Math.floor(targetMs / perRow)));
  }
  return written;
}
