/**
 * Per-candidate cache of the ranked feed.
 *
 * Scoring a feed (fetchScoredJobs) costs hundreds of milliseconds of database
 * and CPU time, and it used to run on every visit, refresh, background refetch
 * and filter change, even though the answer only changes when the candidate's
 * profile or the job pool changes. This stores the ranked list once per
 * candidate + filter set and serves it until it goes stale.
 *
 * Correctness rules, so a cached feed never shows something the live one wouldn't:
 *   - stale after FEED_CACHE_TTL_MINUTES (default 120; ingestion runs every 4h),
 *     or as soon as the candidate's profile or embedding changes;
 *   - hidden jobs, applied jobs and jobs no longer active are dropped at read
 *     time, so hiding, applying and take-downs show up immediately;
 *   - descriptions are not stored (they're the heaviest column); they are read
 *     back for the returned jobs only, as fetchScoredJobs does.
 * FEED_CACHE=off disables it entirely.
 */
import { db } from '../db';
import { sql } from 'drizzle-orm/sql';

type Conn = { execute: typeof db.execute };
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

export interface FeedCacheFilters {
  jobTitle?: string;
  location?: string;
  workType?: string;
  postedWithinDays?: number;
}

export function feedCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FEED_CACHE ?? 'on').toLowerCase() !== 'off';
}

export function feedCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.FEED_CACHE_TTL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 120) * 60_000;
}

/** Same filters, same key: trimmed, case-folded, empty values dropped, fixed field order. */
export function feedCacheKey(filters?: FeedCacheFilters): string {
  const norm = (v?: string) => (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const parts = [
    `t=${norm(filters?.jobTitle)}`,
    `l=${norm(filters?.location)}`,
    `w=${norm(filters?.workType)}`,
    `d=${filters?.postedWithinDays ?? ''}`,
  ];
  return parts.join('|');
}

/** A cached feed is usable while it is younger than the TTL and newer than the last profile change. */
export function isFeedCacheFresh(computedAt: Date, profileChangedAt: Date | null, now: Date, ttlMs: number): boolean {
  if (now.getTime() - computedAt.getTime() > ttlMs) {return false;}
  if (profileChangedAt && profileChangedAt.getTime() >= computedAt.getTime()) {return false;}
  return true;
}

/** What gets stored: the ranked jobs without their heavy text columns. */
export function stripForCache(jobs: any[]): any[] {
  return jobs.map(({ description: _d, requirements: _r, ...job }) => job);
}

/**
 * Turn a cached list back into a live one: drop excluded and no-longer-active
 * jobs, and put the description and requirements back.
 */
export function hydrateCachedFeed(
  cached: any[],
  live: Map<number, { description: string | null; requirements: unknown; status: string | null }>,
  excludeIds: Set<number>,
): any[] {
  const out: any[] = [];
  for (const job of cached) {
    if (typeof job?.id !== 'number') {out.push(job); continue;}  // non-DB rows (none today) pass through
    if (excludeIds.has(job.id)) {continue;}
    const row = live.get(job.id);
    if (!row || row.status !== 'active') {continue;}
    out.push({ ...job, description: row.description ?? null, requirements: Array.isArray(row.requirements) ? row.requirements : [] });
  }
  return out;
}

export async function readFeedCache(
  candidateId: string,
  filters: FeedCacheFilters | undefined,
  excludeIds: Set<number>,
  conn: Conn = db,
  now: Date = new Date(),
): Promise<any[] | null> {
  const r = await conn.execute(sql`
    SELECT c.jobs, c.computed_at, GREATEST(p.updated_at, p.embedding_updated_at) AS profile_changed_at
    FROM candidate_feed_cache c
    LEFT JOIN candidate_users p ON p.user_id = c.candidate_id
    WHERE c.candidate_id = ${candidateId}::uuid AND c.filter_key = ${feedCacheKey(filters)}`);
  const hit = rows(r)[0];
  if (!hit) {return null;}
  const fresh = isFeedCacheFresh(new Date(hit.computed_at), hit.profile_changed_at ? new Date(hit.profile_changed_at) : null, now, feedCacheTtlMs());
  if (!fresh) {return null;}
  const cached: any[] = Array.isArray(hit.jobs) ? hit.jobs : [];
  const ids = cached.map(j => j?.id).filter((id): id is number => typeof id === 'number');
  const live = new Map<number, { description: string | null; requirements: unknown; status: string | null }>();
  if (ids.length) {
    const lr = await conn.execute(sql`
      SELECT id, description, requirements, status FROM job_postings
      WHERE id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`);
    for (const row of rows(lr)) {live.set(row.id, { description: row.description, requirements: row.requirements, status: row.status });}
  }
  return hydrateCachedFeed(cached, live, excludeIds);
}

export async function writeFeedCache(candidateId: string, filters: FeedCacheFilters | undefined, jobs: any[], conn: Conn = db): Promise<void> {
  await conn.execute(sql`
    INSERT INTO candidate_feed_cache (candidate_id, filter_key, jobs, computed_at)
    VALUES (${candidateId}::uuid, ${feedCacheKey(filters)}, ${JSON.stringify(stripForCache(jobs))}::jsonb, NOW())
    ON CONFLICT (candidate_id, filter_key)
    DO UPDATE SET jobs = EXCLUDED.jobs, computed_at = EXCLUDED.computed_at`);
}

/** Delete entries nobody has refreshed recently (filtered feeds especially). Returns rows removed. */
export async function purgeFeedCache(olderThanHours = 48, conn: Conn = db): Promise<number> {
  const r = await conn.execute(sql`
    DELETE FROM candidate_feed_cache WHERE computed_at < NOW() - make_interval(hours => ${olderThanHours})`);
  return (r as any)?.rowCount ?? 0;
}
