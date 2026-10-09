/**
 * Numbers behind the admin console's Growth, Jobs and AI & matching tabs.
 *
 * The database is the source of truth for what it records (sign-ups, resumes,
 * applications, jobs). PostHog fills in only what the database can't see:
 * visitors, feed views and extension autofills. Every funnel step says which
 * source it came from, and PostHog counts are people who did that step in the
 * window, not people followed step by step.
 *
 * The date-series and grouping helpers are pure and unit-tested; queries fail
 * soft so one bad query blanks one chart instead of the tab.
 */
import { db } from '../db';
import { sql } from 'drizzle-orm/sql';

type Conn = { execute: typeof db.execute };
const rows = (r: any): any[] => (r?.rows ?? r) as any[];
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (err) { console.warn(`[admin-insights] ${(err as Error).message.slice(0, 200)}`); return fallback; }
}

export const DAYS = 28;

export interface DayPoint { date: string; value: number }

/** UTC date (YYYY-MM-DD) for each of the last `days` days, oldest first, ending today. */
export function lastDays(days: number, now = new Date()): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** A contiguous daily series: days with no rows are 0, not missing. */
export function fillDays(points: Array<{ day: string | Date; n: number | string }>, days = DAYS, now = new Date()): DayPoint[] {
  const byDay = new Map(points.map(p => [new Date(p.day).toISOString().slice(0, 10), Number(p.n) || 0]));
  return lastDays(days, now).map(date => ({ date, value: byDay.get(date) ?? 0 }));
}

/** The last 7 days against the 7 before them. */
export function weekOverWeek(series: DayPoint[]): { thisWeek: number; priorWeek: number } {
  const sum = (s: DayPoint[]) => s.reduce((a, p) => a + p.value, 0);
  return { thisWeek: sum(series.slice(-7)), priorWeek: sum(series.slice(-14, -7)) };
}

const VENDORS: Record<string, string> = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters', workable: 'Workable',
  breezy: 'Breezy', recruitee: 'Recruitee', workday: 'Workday', bamboohr: 'BambooHR', jobvite: 'Jobvite',
  adzuna: 'Adzuna', jsearch: 'JSearch', remoteok: 'RemoteOK', internal: 'Posted on Recrutas',
};

/** "ATS:greenhouse" and "greenhouse" are the same vendor. */
export function vendorName(source: string | null): string {
  const key = String(source ?? '').replace(/^ats:/i, '').trim().toLowerCase();
  if (!key) {return 'Unknown';}
  return VENDORS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** Group sources by vendor, largest first, folding everything past `top` into "Other". */
export function groupSources(sources: Array<{ source: string | null; n: number | string }>, top = 8): Array<{ label: string; value: number }> {
  const by = new Map<string, number>();
  for (const s of sources) {by.set(vendorName(s.source), (by.get(vendorName(s.source)) ?? 0) + (Number(s.n) || 0));}
  const sorted = [...by.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  if (sorted.length <= top) {return sorted;}
  const other = sorted.slice(top).reduce((a, s) => a + s.value, 0);
  return [...sorted.slice(0, top), { label: 'Other', value: other }];
}

// ── PostHog (visitors, feed views, autofills) ───────────────────────────────

let phCache: { at: number; key: string; value: any } | null = null;
const PH_CACHE_MS = 10 * 60_000;

async function hogql(query: string): Promise<any[][] | null> {
  const token = process.env.POSTHOG_PERSONAL_API_KEY;
  const project = process.env.POSTHOG_PROJECT_ID;
  if (!token || !project) {return null;}
  const host = (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/$/, '');
  const r = await fetch(`${host}/api/projects/${project}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) {throw new Error(`PostHog HTTP ${r.status}`);}
  const data: any = await r.json();
  return data?.results ?? null;
}

/**
 * People who did each event in the last `days` days, plus daily visitors.
 * Two queries, one after the other: run in parallel, PostHog timed them out
 * (2026-10-09). A failed count is null ("not available"), never 0. Cached 10 min.
 */
async function posthogNumbers(days = 30): Promise<{ available: boolean; people: Record<string, number | null>; visitorsDaily: DayPoint[] }> {
  const key = `ph-${days}`;
  if (phCache && phCache.key === key && Date.now() - phCache.at < PH_CACHE_MS) {return phCache.value;}
  const events = ['$pageview', 'job_feed_viewed', 'auto_apply_filled'];
  // One event per query, one query at a time: a combined IN (…) query took
  // 11.5 s and parallel ones queued past the timeout; single ones take ~1.5 s.
  const byEvent = new Map<string, number | null>();
  for (const ev of events) {
    const r = await safe(() => hogql(`SELECT count(DISTINCT distinct_id) FROM events WHERE event = '${ev}' AND timestamp >= now() - INTERVAL ${days} DAY`), null);
    byEvent.set(ev, r ? Number(r[0]?.[0] ?? 0) : null);
  }
  if ([...byEvent.values()].every(v => v === null)) {return { available: false, people: {}, visitorsDaily: [] };}
  const daily = await safe(() => hogql(
    `SELECT toDate(timestamp) AS d, count(DISTINCT distinct_id) FROM events WHERE event = '$pageview' AND timestamp >= now() - INTERVAL ${DAYS} DAY GROUP BY d ORDER BY d`,
  ), null);
  const value = {
    available: true,
    people: Object.fromEntries(events.map(ev => [ev, byEvent.get(ev) ?? null])),
    visitorsDaily: daily ? fillDays(daily.map(r => ({ day: String(r[0]), n: r[1] }))) : [],
  };
  phCache = { at: Date.now(), key, value };
  return value;
}

// ── Growth ───────────────────────────────────────────────────────────────────

export interface FunnelStep { label: string; value: number | null; source: 'database' | 'site analytics' }

/** Site-analytics half of the Growth tab (slow: PostHog), loaded after the database half. */
export async function getGrowthAnalytics() {
  const ph = await safe(() => posthogNumbers(30), { available: false, people: {} as Record<string, number | null>, visitorsDaily: [] as DayPoint[] });
  const p = (ev: string) => (ph.available ? ph.people[ev] ?? null : null);
  return {
    available: ph.available,
    visitors: ph.visitorsDaily,
    funnel: { 'Visited the site': p('$pageview'), 'Opened their feed': p('job_feed_viewed'), 'Used autofill': p('auto_apply_filled') } as Record<string, number | null>,
  };
}

/** Database half of the Growth tab: exact and fast. Site-analytics steps come back null; getGrowthAnalytics fills them. */
export async function getGrowth(conn: Conn = db) {
  const daily = (q: any) => safe(async () => fillDays(rows(await conn.execute(q))), [] as DayPoint[]);
  const one = (q: any) => safe(async () => Number(rows(await conn.execute(q))[0]?.n ?? 0), null as number | null);
  const [signups, resumes, applications, f] = await Promise.all([
    daily(sql`SELECT date_trunc('day', "createdAt") AS day, count(*)::int AS n FROM users
      WHERE "createdAt" > NOW() - INTERVAL '28 days' AND role IS DISTINCT FROM 'system' GROUP BY 1`),
    daily(sql`SELECT date_trunc('day', created_at) AS day, count(DISTINCT user_id)::int AS n FROM activity_logs
      WHERE type = 'resume_parsing_complete' AND created_at > NOW() - INTERVAL '28 days' GROUP BY 1`),
    daily(sql`SELECT date_trunc('day', applied_at) AS day, count(*)::int AS n FROM job_applications
      WHERE applied_at > NOW() - INTERVAL '28 days' GROUP BY 1`),
    Promise.all([
      one(sql`SELECT count(*)::int AS n FROM users WHERE "createdAt" > NOW() - INTERVAL '30 days' AND role IS DISTINCT FROM 'system'`),
      one(sql`SELECT count(DISTINCT user_id)::int AS n FROM activity_logs WHERE type = 'resume_parsing_complete' AND created_at > NOW() - INTERVAL '30 days'`),
      one(sql`SELECT count(DISTINCT candidate_id)::int AS n FROM job_applications WHERE applied_at > NOW() - INTERVAL '30 days'`),
    ]),
  ]);
  const [signedUp, uploaded, applied] = f;
  const funnel: FunnelStep[] = [
    { label: 'Visited the site', value: null, source: 'site analytics' },
    { label: 'Signed up', value: signedUp, source: 'database' },
    { label: 'Uploaded a resume', value: uploaded, source: 'database' },
    { label: 'Opened their feed', value: null, source: 'site analytics' },
    { label: 'Applied to a job', value: applied, source: 'database' },
    { label: 'Used autofill', value: null, source: 'site analytics' },
  ];
  return {
    generatedAt: new Date().toISOString(),
    series: { signups, resumes, applications },
    funnel,
  };
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export async function getJobsInsights(conn: Conn = db) {
  const daily = (q: any) => safe(async () => fillDays(rows(await conn.execute(q))), [] as DayPoint[]);
  const [opened, closed, sources, totals] = await Promise.all([
    daily(sql`SELECT date_trunc('day', created_at) AS day, count(*)::int AS n FROM job_postings
      WHERE created_at > NOW() - INTERVAL '28 days' GROUP BY 1`),
    daily(sql`SELECT date_trunc('day', updated_at) AS day, count(*)::int AS n FROM job_postings
      WHERE status = 'closed' AND updated_at > NOW() - INTERVAL '28 days' GROUP BY 1`),
    safe(async () => rows(await conn.execute(sql`SELECT source, count(*)::int AS n FROM job_postings WHERE status = 'active' GROUP BY 1`)), [] as any[]),
    safe(async () => rows(await conn.execute(sql`
      SELECT count(*)::int AS live, count(DISTINCT company)::int AS companies FROM job_postings WHERE status = 'active'`))[0] ?? {}, {} as any),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    live: totals.live ?? null,
    companies: totals.companies ?? null,
    opened, closed,
    bySource: groupSources(sources),
  };
}

// ── AI & matching ────────────────────────────────────────────────────────────

const ENGINE_LABEL: Record<string, string> = {
  groq: 'Groq', 'gemini-lite': 'Gemini Flash-Lite', 'openrouter-free': 'OpenRouter (free)', cloudflare: 'Cloudflare',
  'gemini-multimodal': 'Gemini (read the PDF)', 'ai-text': 'AI (before provider tracking)', rules: 'Rule engine (no AI)', none: 'Parse failed',
};
export const BEFORE_TRACKING = 'Parsed before tracking';

/** Who read a resume: the AI provider when recorded, else the engine. */
export function engineOf(parse: { aiProvider?: string | null; extractor?: string | null; status?: string | null } | null): string {
  if (!parse) {return 'Not parsed';}
  // Resumes parsed before the engine was recorded (mid-August): read, but by an unknown engine.
  if (!parse.aiProvider && !parse.extractor) {return parse.status === 'failed' ? 'Parse failed' : parse.status === 'completed' ? BEFORE_TRACKING : 'Not parsed';}
  if (parse.aiProvider) {return ENGINE_LABEL[parse.aiProvider] ?? parse.aiProvider;}
  return ENGINE_LABEL[parse.extractor ?? 'none'] ?? String(parse.extractor);
}

export const isAiEngine = (label: string): boolean => !/Rule engine|Not parsed|Parse failed/.test(label) && label !== BEFORE_TRACKING;
export const isRulesEngine = (label: string): boolean => /Rule engine/.test(label);

export async function getAiInsights(conn: Conn = db) {
  const [parses, embed] = await Promise.all([
    safe(async () => rows(await conn.execute(sql`
      SELECT c.parsed_at, c.resume_processing_status AS status, u.email,
        c.resume_parsing_data->>'extractor' AS extractor, c.resume_parsing_data->>'aiProvider' AS ai_provider,
        (c.resume_parsing_data->>'extractedSkillsCount')::int AS skills,
        coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(c.resume_parsing_data->'positions') = 'array' THEN c.resume_parsing_data->'positions' END), 0) AS roles
      FROM candidate_users c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.resume_url IS NOT NULL ORDER BY c.parsed_at DESC NULLS LAST`)), [] as any[]),
    safe(async () => rows(await conn.execute(sql`
      SELECT count(*)::int AS live, count(*) FILTER (WHERE vector_embedding IS NOT NULL)::int AS matched
      FROM job_postings WHERE status = 'active'`))[0] ?? {}, {} as any),
  ]);
  const withEngine = parses.map(p => ({ ...p, engine: engineOf({ aiProvider: p.ai_provider, extractor: p.extractor, status: p.status }) }));
  const byEngine = new Map<string, number>();
  for (const p of withEngine) {byEngine.set(p.engine, (byEngine.get(p.engine) ?? 0) + 1);}
  const total = withEngine.length;
  const byAi = withEngine.filter(p => isAiEngine(p.engine)).length;
  return {
    generatedAt: new Date().toISOString(),
    resumes: total,
    readByAi: byAi,
    onRules: withEngine.filter(p => isRulesEngine(p.engine)).length,
    untracked: withEngine.filter(p => p.engine === BEFORE_TRACKING).length,
    engines: [...byEngine.entries()].map(([label, value]) => ({ label, value, kind: isAiEngine(label) ? 'ai' : isRulesEngine(label) ? 'rules' : 'other' })).sort((a, b) => b.value - a.value),
    recent: withEngine.slice(0, 12).map(p => ({
      at: p.parsed_at ? new Date(p.parsed_at).toISOString() : null,
      email: p.email ?? null, engine: p.engine, kind: isAiEngine(p.engine) ? 'ai' : isRulesEngine(p.engine) ? 'rules' : 'other',
      skills: p.skills ?? null, roles: Number(p.roles) || 0, status: p.status ?? null,
    })),
    matching: { liveJobs: embed.live ?? null, matched: embed.matched ?? null },
  };
}
