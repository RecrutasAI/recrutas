/**
 * The admin console's "Today" overview: the numbers an operator checks first,
 * and capacity signals graded green / amber / red against the thresholds in
 * docs/scaling-strategy.md (section 5, "Signals and triggers").
 *
 * evaluateSignals() is pure so the thresholds are unit-tested; getOverview()
 * gathers the inputs. Every query is independent and fails soft: one missing
 * table or slow query shows that signal as "unknown" instead of failing the page.
 */
import { db } from '../db';
import { realUserIds } from '../lib/real-users';
import { sql } from 'drizzle-orm/sql';
import { getSettings, type Settings } from './runtime-settings.service';
import { BUSY_NOTICE } from './autopilot.service';
import {
  RUNNABLE_JOBS, jobForPipeline, latestRequests, activeSnoozes,
  type RunnableJobKey, type JobRequest, type Snooze,
} from './admin-actions.service';

type Conn = { execute: typeof db.execute };
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

export type Level = 'green' | 'amber' | 'red' | 'unknown';

export interface Signal {
  key: string;
  label: string;
  value: number | null;
  display: string;
  level: Level;
  healthy: string;   // what green means, in words
  actAt: string;     // when it turns red
  playbook: string;  // what is going on, in plain words, when it isn't green
  /** What the console offers when it isn't green: buttons, or a decision that costs money. */
  actions: SignalAction[];
  /** Set when an admin snoozed it: it stays visible but leaves "Needs attention". */
  snoozedUntil?: string | null;
}

export type SignalAction =
  | { kind: 'run'; job: RunnableJobKey; label: string }
  | { kind: 'setting'; key: keyof Settings; value: unknown; label: string }
  /** Costs money or needs someone on the server: shown with its price, never a button. */
  | { kind: 'decision'; label: string; detail: string };

const run = (job: RunnableJobKey, label: string = RUNNABLE_JOBS[job].title): SignalAction => ({ kind: 'run', job, label });
const setTo = (key: keyof Settings, value: unknown, label: string): SignalAction => ({ kind: 'setting', key, value, label });
const PAUSE_JOBS = setTo('pauseNonEssentialCrons', true, 'Pause background jobs');
const LONG_CACHE = setTo('feedCacheTtlMinutes', 360, 'Cache feeds for 6 hours');

export interface CapacityInput {
  feedP95Ms: number | null;
  feedSamples: number;
  dbConnections: number | null;
  maxConnections: number | null;
  memAvailableMb: number | null;
  load1: number | null;
  cpus: number | null;
  diskPct: number | null;
  activeJobs: number | null;
  embeddingBacklog: number | null;
  /** Minutes the oldest live job has waited for its matching data (null when none is waiting). */
  embeddingOldestMin?: number | null;
  failingPipelines: number | null;
  /** Names of the scheduled jobs whose last run failed. */
  failingPipelineNames?: string[];
  healthCheckAgeMin: number | null;
  /** Résumés parsed in the last 7 days, and how many of them are still on the rule engine (no AI answered). */
  parses7d?: number | null;
  parsesOnRules7d?: number | null;
  /** Sign-ups in the last 7 days: with the parse signal, the "pay for AI" trigger. */
  signups7d?: number | null;
}

/** Below this many parses a week the share is noise; the signal reads "unknown". */
export const MIN_PARSES_FOR_SIGNAL = 5;
/** Sign-ups a week that count as an influx (docs/scaling-strategy.md: pay only on real demand). */
export const INFLUX_SIGNUPS_7D = 50;

// Below `amber` is green, from `amber` up to `red` is amber, at `red` or above is red.
function grade(value: number | null, amber: number, red: number, unknown = false): Level {
  if (value === null || !Number.isFinite(value) || unknown) {return 'unknown';}
  return value >= red ? 'red' : value >= amber ? 'amber' : 'green';
}
// For "more is better" values (free RAM): below `red` is red, below `amber` is amber.
function gradeLow(value: number | null, amber: number, red: number): Level {
  if (value === null || !Number.isFinite(value)) {return 'unknown';}
  return value < red ? 'red' : value < amber ? 'amber' : 'green';
}
const n = (v: number | null, unit = '') => (v === null || !Number.isFinite(v) ? 'not measured' : `${Math.round(v).toLocaleString('en-US')}${unit}`);

/** Thresholds from docs/scaling-strategy.md section 5. A feed p95 from fewer than 5 requests is not graded. */
export function evaluateSignals(i: CapacityInput): Signal[] {
  const loadPerCpu = i.load1 !== null && i.cpus ? i.load1 / i.cpus : null;
  const failing = (i.failingPipelineNames ?? []);
  return [
    {
      key: 'feedP95', label: 'Feed response time (p95, 24h)', value: i.feedP95Ms,
      display: i.feedP95Ms === null ? 'not measured' : `${(i.feedP95Ms / 1000).toFixed(1)} s${i.feedSamples < 5 ? ` (only ${i.feedSamples} requests)` : ''}`,
      level: grade(i.feedP95Ms, 500, 2000, i.feedSamples < 5),
      healthy: 'under 0.5 s', actAt: 'over 2 s',
      playbook: 'Candidates wait too long for their feed. Serving feeds from cache for longer makes repeat visits instant right away.',
      actions: [setTo('feedCache', true, 'Turn the feed cache on'), LONG_CACHE],
    },
    {
      key: 'dbConnections', label: 'Database connections', value: i.dbConnections,
      display: i.dbConnections === null ? 'not measured' : `${i.dbConnections} of ${i.maxConnections ?? '?'}`,
      level: grade(i.dbConnections, 20, 40),
      healthy: 'under 20', actAt: 'over 40',
      playbook: 'The database is close to its connection limit; past it, visitors get errors. Pausing background jobs frees connections, and the notice tells visitors pages may be slow. Autopilot also closes idle connections above 40.',
      actions: [PAUSE_JOBS, setTo('noticeBanner', BUSY_NOTICE, 'Show the "busy" notice')],
    },
    {
      key: 'ramFree', label: 'Server RAM free', value: i.memAvailableMb,
      display: n(i.memAvailableMb, ' MB'), level: gradeLow(i.memAvailableMb, 400, 200),
      healthy: 'over 400 MB', actAt: 'under 200 MB',
      playbook: 'The server is short of memory, so background jobs and the database compete with the site. Pausing background jobs frees memory now.',
      actions: [PAUSE_JOBS, { kind: 'decision', label: 'Bigger server', detail: 'An 8 GB Hetzner server is about €15 a month. Worth it only if this stays red with background jobs paused.' }],
    },
    {
      key: 'cpuLoad', label: 'Server CPU load (per core)', value: loadPerCpu,
      display: loadPerCpu === null ? 'not measured' : `${loadPerCpu.toFixed(2)} × ${i.cpus} cores`,
      level: grade(loadPerCpu, 1, 1.5),
      healthy: 'under 1.0 per core', actAt: 'over 1.5 per core',
      playbook: 'The server is busy. Pausing background jobs and caching feeds longer frees CPU for visitors.',
      actions: [PAUSE_JOBS, LONG_CACHE, { kind: 'decision', label: 'Bigger server', detail: 'About €15 a month for 8 GB / 4 cores. Only if it stays busy with background jobs paused.' }],
    },
    {
      key: 'disk', label: 'Server disk used', value: i.diskPct,
      display: n(i.diskPct, '%'), level: grade(i.diskPct, 75, 85),
      healthy: 'under 75%', actAt: 'over 85%',
      playbook: 'The server disk is filling up. The usual cause is database logs (WAL) or backups not being cleaned up, which needs someone on the server; a full disk stops the database.',
      actions: [run('vps-db-health', 'Re-check the server now'), { kind: 'decision', label: 'More disk', detail: 'A 100 GB Hetzner volume is about €5 a month. Only after log and backup cleanup has been checked.' }],
    },
    {
      key: 'activeJobs', label: 'Live jobs', value: i.activeJobs,
      display: n(i.activeJobs), level: grade(i.activeJobs, 200_000, 250_000),
      healthy: 'under 200,000', actAt: '250,000 (server upgrade trigger)',
      playbook: 'Past about 250,000 live jobs the matching index no longer fits in the server\'s memory and matching slows down.',
      actions: [{ kind: 'decision', label: 'Bigger server before 250,000', detail: 'An 8 GB Hetzner server is about €15 a month.' }],
    },
    embeddingSignal(i),
    {
      key: 'failingPipelines', label: 'Scheduled jobs failing', value: i.failingPipelines,
      display: i.failingPipelines === null ? 'not measured' : failing.length ? failing.join(', ') : n(i.failingPipelines),
      level: grade(i.failingPipelines, 1, 3),
      healthy: 'none', actAt: '3 or more',
      playbook: 'These scheduled jobs failed on their last run. Running one again often clears a one-off failure; its last error is under Scheduled jobs.',
      actions: failing.map(jobForPipeline).filter((j): j is RunnableJobKey => !!j).slice(0, 3).map(j => run(j, `Run "${RUNNABLE_JOBS[j].title}" again`)),
    },
    {
      key: 'healthCheck', label: 'Server health check last reported', value: i.healthCheckAgeMin,
      display: i.healthCheckAgeMin === null ? 'never' : `${Math.round(i.healthCheckAgeMin)} min ago`,
      level: i.healthCheckAgeMin === null ? 'red' : grade(i.healthCheckAgeMin, 20, 60),
      healthy: 'within 20 min', actAt: 'over an hour',
      playbook: 'The server\'s health report is overdue. Run it now: if the request stays "queued" for more than 2 minutes, the server itself or its scheduler is down.',
      actions: [run('vps-db-health', 'Run the health check now')],
    },
    aiParseSignal(i),
  ];
}

/**
 * Résumé parsing runs on free AI tiers (Groq → Gemini Lite → OpenRouter free →
 * Cloudflare). When they all run out, a parse falls to the rule engine, which
 * gets companies and titles wrong; the retry cron upgrades it once capacity is
 * back. A high share still on rules means the free tiers no longer cover the
 * demand. Paying is the playbook ONLY when that coincides with a real influx of
 * sign-ups (the founder's rule, 2026-10-08) and funding is in place.
 */
/**
 * New jobs get their matching data in a batch every 6 hours, so a few thousand
 * waiting between batches is normal: graded on how long the OLDEST has waited
 * (a missed batch), not on how many are waiting.
 */
export const EMBED_AMBER_MIN = 8 * 60;
export const EMBED_RED_MIN = 14 * 60;
function embeddingSignal(i: CapacityInput): Signal {
  const waiting = i.embeddingBacklog;
  const oldest = waiting === 0 ? 0 : (i.embeddingOldestMin ?? null);
  const hours = (m: number) => (m < 90 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);
  return {
    key: 'embeddingBacklog', label: 'New jobs waiting to be matched', value: oldest,
    display: waiting === null ? 'not measured' : waiting === 0 ? 'none waiting'
      : `${waiting.toLocaleString('en-US')} waiting${oldest !== null ? ` · oldest ${hours(oldest)}` : ''}`,
    level: waiting === null ? 'unknown' : grade(oldest, EMBED_AMBER_MIN, EMBED_RED_MIN),
    healthy: 'oldest under 8 h (batches run every 6 h)', actAt: 'oldest over 14 h (two batches missed)',
    playbook: 'New jobs get their matching data in a batch every 6 hours. The oldest has waited longer than that, so a batch was missed and these jobs are not reaching candidates yet.',
    actions: [run('batch-embeddings', 'Match new jobs now')],
  };
}

function aiParseSignal(i: CapacityInput): Signal {
  const total = i.parses7d ?? null;
  const onRules = i.parsesOnRules7d ?? null;
  const tooFew = total === null || onRules === null || total < MIN_PARSES_FOR_SIGNAL;
  const pct = total && onRules !== null ? (100 * onRules) / total : null;
  const influx = (i.signups7d ?? 0) >= INFLUX_SIGNUPS_7D;
  return {
    key: 'aiParse', label: 'Resumes stuck on the rule engine (7 days)', value: pct,
    display: total === null || onRules === null ? 'not measured'
      : `${onRules} of ${total}${pct === null ? '' : ` (${Math.round(pct)}%)`}${tooFew ? ' (too few to judge)' : ''}`,
    level: tooFew ? 'unknown' : grade(pct, 10, 25),
    healthy: 'under 10%: the free AI tiers cover demand', actAt: '25% or more',
    playbook: influx
      ? `The free AI providers are not keeping up while sign-ups are an influx (${i.signups7d} in 7 days). These resumes show rule-engine guesses until an AI reads them.`
      : 'The free AI providers ran short, so these resumes show rule-engine guesses (blank where it can\'t tell). The retry job re-reads them every 10 minutes as quotas reset; there is no sign-up influx, so stay free.',
    actions: [
      run('retry-failed-parses', 'Retry these parses now'),
      ...(influx ? [{ kind: 'decision' as const, label: 'Pay for AI (the "pay" trigger)', detail: 'Influx detected. If funding is in place: turn on billing in the Groq console (console.groq.com → Settings → Billing). Groq is already first in the rotation and keeps the same key, so nothing is redeployed. gpt-oss-20b costs $0.075 / $0.30 per million tokens in / out (Groq, 2026-10-10), about $0.001 per resume: $10 covers ~10,000 resumes.' }] : []),
    ],
  };
}

/** The worst level among the signals, ignoring unknowns. */
export function overallLevel(signals: Signal[]): Level {
  // A snoozed signal is still shown, but an admin has accepted it.
  const known = signals.filter(s => !s.snoozedUntil).map(s => s.level).filter(l => l !== 'unknown');
  if (known.includes('red')) {return 'red';}
  if (known.includes('amber')) {return 'amber';}
  return known.length ? 'green' : 'unknown';
}

async function one<T>(conn: Conn, q: any, pick: (r: any) => T, fallback: T): Promise<T> {
  try { const r = rows(await conn.execute(q))[0]; return r ? pick(r) : fallback; } catch { return fallback; }
}
const num = (v: any): number | null => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export interface Overview {
  generatedAt: string;
  level: Level;
  today: {
    signups24h: number | null; signups7d: number | null; users: number | null; activeUsers7d: number | null;
    resumes: number | null; applications7d: number | null; liveJobs: number | null; jobsOpened24h: number | null; jobsClosed24h: number | null;
  };
  signals: Signal[];
  settings: Settings;
  /** Every job the console can run, with its last scheduled-or-requested run and the newest console request. */
  jobs: Array<{
    key: RunnableJobKey; title: string; description: string;
    lastRun: { status: string; at: string; message: string | null } | null;
    request: JobRequest | null;
  }>;
  snoozes: Record<string, Snooze>;
}

export async function getOverview(conn: Conn = db): Promise<Overview> {
  const count = (q: any) => one(conn, q, r => num(r.n), null as number | null);
  const pipelines = Object.values(RUNNABLE_JOBS).map(j => j.pipeline);
  const [signups24h, signups7d, users, active7d, resumes, apps7d, feed, conns, health, jobs, backlog, failing, parses, settings, lastRuns, requests, snoozes] = await Promise.all([
    count(sql`SELECT count(*)::int AS n FROM users WHERE "createdAt" > NOW() - INTERVAL '24 hours' AND id IN ${realUserIds}`),
    count(sql`SELECT count(*)::int AS n FROM users WHERE "createdAt" > NOW() - INTERVAL '7 days' AND id IN ${realUserIds}`),
    count(sql`SELECT count(*)::int AS n FROM users WHERE id IN ${realUserIds}`),
    count(sql`SELECT count(DISTINCT user_id)::int AS n FROM activity_logs WHERE created_at > NOW() - INTERVAL '7 days' AND user_id IN ${realUserIds}`),
    count(sql`SELECT count(*)::int AS n FROM candidate_users WHERE resume_url IS NOT NULL AND user_id IN ${realUserIds}`),
    count(sql`SELECT count(*)::int AS n FROM job_applications WHERE applied_at > NOW() - INTERVAL '7 days' AND candidate_id IN ${realUserIds}`),
    one(conn, sql`
      SELECT count(*)::int AS n, percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95
      FROM request_metrics WHERE endpoint = '/api/ai-matches' AND created_at > NOW() - INTERVAL '24 hours'`,
      r => ({ n: Number(r.n) || 0, p95: num(r.p95) }), { n: 0, p95: null }),
    one(conn, sql`SELECT (SELECT count(*) FROM pg_stat_activity)::int AS used, current_setting('max_connections')::int AS max`,
      r => ({ used: num(r.used), max: num(r.max) }), { used: null, max: null }),
    one(conn, sql`
      SELECT stats, EXTRACT(EPOCH FROM (NOW() - started_at)) / 60 AS age_min
      FROM pipeline_runs WHERE pipeline = 'vps-db-health' ORDER BY started_at DESC LIMIT 1`,
      r => ({ stats: r.stats ?? {}, ageMin: num(r.age_min) }), { stats: {} as any, ageMin: null }),
    one(conn, sql`
      SELECT count(*) FILTER (WHERE status = 'active')::int AS live,
             count(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS opened,
             count(*) FILTER (WHERE status = 'closed' AND updated_at > NOW() - INTERVAL '24 hours')::int AS closed
      FROM job_postings`,
      r => r, null as any),
    one(conn, sql`
      SELECT count(*)::int AS n, EXTRACT(EPOCH FROM (NOW() - min(created_at))) / 60 AS oldest_min
      FROM job_postings WHERE status = 'active' AND vector_embedding IS NULL`,
      r => ({ n: num(r.n), oldestMin: num(r.oldest_min) }), { n: null as number | null, oldestMin: null as number | null }),
    // A pipeline is failing when its latest run was not ok.
    one(conn, sql`
      SELECT count(*)::int AS n, coalesce(array_agg(pipeline ORDER BY pipeline) FILTER (WHERE pipeline IS NOT NULL), '{}') AS names FROM (
        SELECT DISTINCT ON (pipeline) pipeline, status FROM pipeline_runs
        WHERE started_at > NOW() - INTERVAL '3 days' ORDER BY pipeline, started_at DESC
      ) last WHERE status = 'error'`,
      r => ({ n: num(r.n), names: (r.names ?? []) as string[] }), { n: null as number | null, names: [] as string[] }),
    one(conn, sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE resume_parsing_data->>'extractor' IN ('rules', 'none'))::int AS on_rules
      FROM candidate_users WHERE parsed_at > NOW() - INTERVAL '7 days' AND user_id IN ${realUserIds}`,
      r => ({ total: num(r.total), onRules: num(r.on_rules) }), { total: null, onRules: null }),
    getSettings(conn),
    conn.execute(sql`
      SELECT DISTINCT ON (pipeline) pipeline, status, started_at, message FROM pipeline_runs
      WHERE pipeline IN ${pipelines} AND started_at > NOW() - INTERVAL '14 days'
      ORDER BY pipeline, started_at DESC`).then(rows).catch(() => [] as any[]),
    latestRequests(conn).catch(() => ({} as Record<string, JobRequest>)),
    activeSnoozes(conn).catch(() => ({} as Record<string, Snooze>)),
  ]);

  const s = health.stats || {};
  const signals = evaluateSignals({
    feedP95Ms: feed.p95, feedSamples: feed.n,
    dbConnections: conns.used, maxConnections: conns.max,
    memAvailableMb: num(s.memAvailableMb), load1: num(s.load1), cpus: num(s.cpus), diskPct: num(s.diskPct),
    activeJobs: num(jobs?.live), embeddingBacklog: backlog.n, embeddingOldestMin: backlog.oldestMin,
    failingPipelines: failing.n, failingPipelineNames: failing.names, healthCheckAgeMin: health.ageMin,
    parses7d: parses.total, parsesOnRules7d: parses.onRules, signups7d,
  }).map(sig => ({ ...sig, snoozedUntil: snoozes[sig.key]?.until ?? null }));
  const runByPipeline = new Map(lastRuns.map((r: any) => [r.pipeline, r]));

  return {
    generatedAt: new Date().toISOString(),
    level: overallLevel(signals),
    today: {
      signups24h, signups7d, users, activeUsers7d: active7d, resumes, applications7d: apps7d,
      liveJobs: num(jobs?.live), jobsOpened24h: num(jobs?.opened), jobsClosed24h: num(jobs?.closed),
    },
    signals,
    settings,
    jobs: (Object.keys(RUNNABLE_JOBS) as RunnableJobKey[]).map(key => {
      const j = RUNNABLE_JOBS[key];
      const r: any = runByPipeline.get(j.pipeline);
      return {
        key, title: j.title, description: j.description,
        lastRun: r ? { status: r.status, at: new Date(r.started_at).toISOString(), message: r.message ?? null } : null,
        request: requests[key] ?? null,
      };
    }),
    snoozes,
  };
}
