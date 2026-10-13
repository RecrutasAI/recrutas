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
import { realUserIds } from '../lib/real-users';

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

/** A PostHog query (HogQL, funnels…) through the query API; null when read access isn't set up. */
async function posthogQuery(query: Record<string, unknown>, timeoutMs = 20_000): Promise<any | null> {
  const token = process.env.POSTHOG_PERSONAL_API_KEY;
  const project = process.env.POSTHOG_PROJECT_ID;
  if (!token || !project) {return null;}
  const host = (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/$/, '');
  const r = await fetch(`${host}/api/projects/${project}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {throw new Error(`PostHog HTTP ${r.status}`);}
  const data: any = await r.json();
  return data?.results ?? null;
}

async function hogql(query: string): Promise<any[][] | null> {
  return posthogQuery({ kind: 'HogQLQuery', query });
}

// ── Activation, person by person ──────────────────────────────────────────────
// Phase 1's metric (gtm-plan A3): the same people, in order, from sign-up to autofill. A
// count per event ("how many ever did X") can rise between steps and says nothing about
// who converted, so each person is followed through the steps. Sign-up and resume come
// from the database (exact); feed and autofill exist only in PostHog. PostHog's own
// funnel was dropped: its first two events were missing for real people (server events
// lost on Vercel, 3 of 8 sign-ups in Sep-Oct 2026), which hid them from every step.
// Only real accounts count (server/lib/real-users.ts).

export const ACTIVATION_STEPS = [
  { event: 'signup', label: 'Signed up' },
  { event: 'resume_parsing_complete', label: 'Uploaded a resume' },
  { event: 'job_feed_viewed', label: 'Opened their feed' },
  { event: 'auto_apply_filled', label: 'Used autofill' },
] as const;

export interface ActivationStep { label: string; event: string; people: number; fromPrevious: number | null; fromStart: number | null; avgHoursFromPrevious: number | null }

/** One account's times: sign-up and first resume from the database, every feed view and autofill from PostHog. */
export interface PersonTimes { signup: Date; resume: Date | null; feeds: Date[]; autofills: Date[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKEW_MS = 60_000;  // PostHog and database clocks differ by seconds

/**
 * The ordered funnel: a person reaches a step only by doing it after the step before,
 * within `windowDays` of signing up. Typical time = mean, to the whole minute.
 */
export function orderedSteps(people: PersonTimes[], windowDays = 30): ActivationStep[] {
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  const reached = ACTIVATION_STEPS.map(() => 0);
  const gaps: number[][] = ACTIVATION_STEPS.map(() => []);
  for (const p of people) {
    const deadline = p.signup.getTime() + windowDays * 86_400_000;
    const after = (times: Array<Date | null>, from: number) => times
      .map(t => t?.getTime() ?? NaN).filter(t => Number.isFinite(t) && t >= from - SKEW_MS && t <= deadline).sort((a, b) => a - b)[0];
    const steps: Array<Array<Date | null>> = [[p.resume], p.feeds, p.autofills];
    let at = p.signup.getTime();
    reached[0]++;
    for (let i = 1; i < ACTIVATION_STEPS.length; i++) {
      const t = after(steps[i - 1], at);
      if (t === undefined) {break;}
      reached[i]++;
      gaps[i].push(Math.max(0, t - at));
      at = t;
    }
  }
  return ACTIVATION_STEPS.map((step, i) => {
    const mean = gaps[i].length ? gaps[i].reduce((a, b) => a + b, 0) / gaps[i].length : NaN;
    return {
      label: step.label, event: step.event, people: reached[i],
      fromPrevious: i === 0 ? null : pct(reached[i], reached[i - 1]),
      fromStart: i === 0 ? null : pct(reached[i], reached[0]),
      avgHoursFromPrevious: i > 0 && Number.isFinite(mean) ? Math.max(1, Math.round(mean / 60_000)) / 60 : null,
    };
  });
}

/** Feed views and autofills per account, from PostHog; null when it isn't reachable. */
async function featureTimes(ids: string[], days: number): Promise<Map<string, { feeds: Date[]; autofills: Date[] }> | null> {
  const out = new Map<string, { feeds: Date[]; autofills: Date[] }>();
  const valid = ids.filter(id => UUID.test(id));
  for (let i = 0; i < valid.length; i += 500) {
    const chunk = valid.slice(i, i + 500).map(id => `'${id}'`).join(', ');
    const res = await posthogQuery({
      kind: 'HogQLQuery',
      query: `SELECT distinct_id, event, arraySort(groupArray(200)(timestamp)) FROM events
        WHERE event IN ('job_feed_viewed', 'auto_apply_filled') AND distinct_id IN (${chunk})
          AND timestamp >= now() - INTERVAL ${Math.ceil(days) + 31} DAY
        GROUP BY distinct_id, event`,
    }, 45_000);
    if (!res) {return null;}
    for (const [id, event, times] of res as Array<[string, string, string[]]>) {
      const entry = out.get(id) ?? { feeds: [], autofills: [] };
      const dates = (times ?? []).map(t => new Date(/Z|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`));
      if (event === 'job_feed_viewed') {entry.feeds = dates;} else {entry.autofills = dates;}
      out.set(id, entry);
    }
  }
  return out;
}

/**
 * The activation funnel for real accounts that signed up in the last `days` days (only those
 * in `onlyIds`, when given: one channel's sign-ups). Null when PostHog isn't reachable.
 */
export async function activationForIds(onlyIds: string[] | null, days: number, conn: Conn = db): Promise<ActivationStep[] | null> {
  const users = rows(await conn.execute(sql`
    SELECT u.id::text AS id, u."createdAt" AS signup,
           (SELECT min(a.created_at) FROM activity_logs a WHERE a.user_id = u.id AND a.type = 'resume_parsing_complete') AS resume
    FROM users u
    WHERE u."createdAt" > NOW() - make_interval(days => ${days}) AND u.role IS DISTINCT FROM 'system' AND u.id IN ${realUserIds}`))
    .filter(u => !onlyIds || onlyIds.includes(String(u.id)));
  const times = users.length ? await featureTimes(users.map(u => String(u.id)), days) : new Map();
  if (!times) {return null;}
  return orderedSteps(users.map(u => ({
    signup: new Date(u.signup),
    resume: u.resume ? new Date(u.resume) : null,
    feeds: times.get(String(u.id))?.feeds ?? [],
    autofills: times.get(String(u.id))?.autofills ?? [],
  })));
}

let activationCache: { at: number; key: string; value: ActivationStep[] | null } | null = null;

/** The activation funnel for everyone who signed up in the last `days` days. Cached 10 min. */
export async function activationFunnel(days = 90, conn: Conn = db): Promise<ActivationStep[] | null> {
  const key = `act-${days}`;
  if (activationCache && activationCache.key === key && Date.now() - activationCache.at < PH_CACHE_MS) {return activationCache.value;}
  const value = await activationForIds(null, days, conn);
  activationCache = { at: Date.now(), key, value };
  return value;
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

// ── Where people come from, and who is waiting (gtm-plan: channels, stop rule) ─────────

export interface Labeled { label: string; value: number }

/** Visitors in the last `days` days by referring site and by utm_source (people, not visits); null without PostHog. */
// Our own machines: the VPS (browser tests) plus any prefixes in INTERNAL_IP_PREFIXES (comma
// separated, e.g. the founder's home network), so our own visits aren't counted as visitors.
const internalIpFilter = (): string => {
  const prefixes = ['178.156.193.183', ...(process.env.INTERNAL_IP_PREFIXES || '').split(',')]
    .map(p => p.trim()).filter(p => /^[0-9a-f.:]+$/i.test(p));
  return prefixes.map(p => `startsWith(toString(properties.$ip), '${p}')`).join(' OR ');
};

export async function trafficSources(days = 7): Promise<{ visitors: number; referrers: Labeled[]; campaigns: Labeled[] } | null> {
  const where = `event = '$pageview' AND timestamp >= now() - INTERVAL ${Math.ceil(days)} DAY AND NOT (${internalIpFilter()})`;
  const top = async (prop: string) => {
    // Each visitor's FIRST page view in the window (how they arrived), not every page's referrer:
    // clicking around the site would otherwise credit recrutas.ai itself. Person profiles aren't
    // kept for anonymous visitors, so $initial_* person properties are empty.
    const r = await hogql(`SELECT k, count() AS n FROM (
        SELECT distinct_id, argMin(coalesce(nullIf(toString(properties.${prop}), ''), '(none)'), timestamp) AS k
        FROM events WHERE ${where} GROUP BY distinct_id)
      GROUP BY k ORDER BY n DESC LIMIT 10`);
    const label = (k: string) => (k === '$direct' ? 'direct (typed or bookmarked)' : /(^|\.)recrutas\.ai$/.test(k) ? 'recrutas.ai (from another page)' : k);
    return r ? r.map(x => ({ label: label(String(x[0])), value: Number(x[1]) || 0 })) : null;
  };
  const v = await hogql(`SELECT count(DISTINCT distinct_id) FROM events WHERE ${where}`);
  if (!v) {return null;}
  const referrers = await top('$referring_domain');
  const campaigns = await top('utm_source');
  return { visitors: Number(v[0]?.[0] ?? 0), referrers: referrers ?? [], campaigns: (campaigns ?? []).filter(c => c.label !== '(none)') };
}

/** Real sign-ups in the last `days` days by channel (the ?code= prefix; 'none' without one). */
export async function signupsByChannel(days = 30, conn: Conn = db): Promise<Labeled[]> {
  return rows(await conn.execute(sql`
    SELECT COALESCE(NULLIF(lower(signup_source), ''), 'none') AS label, count(*)::int AS value FROM users
    WHERE "createdAt" > NOW() - make_interval(days => ${days}) AND role IS DISTINCT FROM 'system' AND id IN ${realUserIds}
    GROUP BY 1 ORDER BY 2 DESC`)).map(r => ({ label: String(r.label), value: Number(r.value) }));
}

export interface Interest { days: number; employers: { recent: number; total: number }; outsideUs: { recent: number; total: number; byCountry: Labeled[] }; earlyAccess: { recent: number; total: number } }

/** The waitlist: employers asking for access, people outside the US (by country), early-access requests. */
export async function interestSummary(days = 7, conn: Conn = db): Promise<Interest> {
  const r = rows(await conn.execute(sql`
    SELECT CASE WHEN source = 'employer' THEN 'employer' WHEN source LIKE 'non-us:%' THEN 'outside' ELSE 'early' END AS kind,
           upper(NULLIF(split_part(source, ':', 2), '')) AS country,
           count(*) FILTER (WHERE created_at > NOW() - make_interval(days => ${days}))::int AS recent, count(*)::int AS total
    FROM waitlist_entries GROUP BY 1, 2`));
  const sumOf = (kind: string) => r.filter(x => x.kind === kind).reduce((a, x) => ({ recent: a.recent + Number(x.recent), total: a.total + Number(x.total) }), { recent: 0, total: 0 });
  return {
    days,
    employers: sumOf('employer'),
    outsideUs: { ...sumOf('outside'), byCountry: r.filter(x => x.kind === 'outside').map(x => ({ label: String(x.country || '?'), value: Number(x.total) })).sort((a, b) => b.value - a.value).slice(0, 8) },
    earlyAccess: sumOf('early'),
  };
}

// ── Growth ───────────────────────────────────────────────────────────────────

export interface FunnelStep { label: string; value: number | null; source: 'database' | 'site analytics' }

/** Site-analytics half of the Growth tab (slow: PostHog), loaded after the database half. */
export async function getGrowthAnalytics() {
  const ph = await safe(() => posthogNumbers(30), { available: false, people: {} as Record<string, number | null>, visitorsDaily: [] as DayPoint[] });
  const p = (ev: string) => (ph.available ? ph.people[ev] ?? null : null);
  const activation = await safe(() => activationFunnel(90), null as ActivationStep[] | null);
  const sources = await safe(() => trafficSources(7), null);
  return {
    available: ph.available,
    activation,
    sources,
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
      WHERE "createdAt" > NOW() - INTERVAL '28 days' AND role IS DISTINCT FROM 'system' AND id IN ${realUserIds} GROUP BY 1`),
    daily(sql`SELECT date_trunc('day', created_at) AS day, count(DISTINCT user_id)::int AS n FROM activity_logs
      WHERE type = 'resume_parsing_complete' AND created_at > NOW() - INTERVAL '28 days' AND user_id IN ${realUserIds} GROUP BY 1`),
    daily(sql`SELECT date_trunc('day', applied_at) AS day, count(*)::int AS n FROM job_applications
      WHERE applied_at > NOW() - INTERVAL '28 days' AND candidate_id IN ${realUserIds} GROUP BY 1`),
    Promise.all([
      one(sql`SELECT count(*)::int AS n FROM users WHERE "createdAt" > NOW() - INTERVAL '30 days' AND role IS DISTINCT FROM 'system' AND id IN ${realUserIds}`),
      one(sql`SELECT count(DISTINCT user_id)::int AS n FROM activity_logs WHERE type = 'resume_parsing_complete' AND created_at > NOW() - INTERVAL '30 days' AND user_id IN ${realUserIds}`),
      one(sql`SELECT count(DISTINCT candidate_id)::int AS n FROM job_applications WHERE applied_at > NOW() - INTERVAL '30 days' AND candidate_id IN ${realUserIds}`),
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
  const [channels, interest] = await Promise.all([
    safe(() => signupsByChannel(30, conn), [] as Labeled[]),
    safe(() => interestSummary(7, conn), null as Interest | null),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    series: { signups, resumes, applications },
    funnel,
    channels,
    interest,
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
      WHERE c.resume_url IS NOT NULL AND c.user_id IN ${realUserIds} ORDER BY c.parsed_at DESC NULLS LAST`)), [] as any[]),
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
