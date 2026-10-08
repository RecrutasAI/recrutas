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
import { sql } from 'drizzle-orm/sql';
import { getSettings, type Settings } from './runtime-settings.service';

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
  playbook: string;  // what to do when it isn't green
}

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
  failingPipelines: number | null;
  healthCheckAgeMin: number | null;
}

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
  return [
    {
      key: 'feedP95', label: 'Feed response time (p95, 24h)', value: i.feedP95Ms,
      display: i.feedP95Ms === null ? 'not measured' : `${(i.feedP95Ms / 1000).toFixed(1)} s${i.feedSamples < 5 ? ` (only ${i.feedSamples} requests)` : ''}`,
      level: grade(i.feedP95Ms, 500, 2000, i.feedSamples < 5),
      healthy: 'under 0.5 s', actAt: 'over 2 s',
      playbook: 'Turn the feed cache on and lengthen its lifetime; if it stays slow, move to scaling Phase 1.',
    },
    {
      key: 'dbConnections', label: 'Database connections', value: i.dbConnections,
      display: i.dbConnections === null ? 'not measured' : `${i.dbConnections} of ${i.maxConnections ?? '?'}`,
      level: grade(i.dbConnections, 20, 40),
      healthy: 'under 20', actAt: 'over 40',
      playbook: 'Pause background jobs and show the busy notice; then add a connection pooler (pgBouncer) or a bigger box.',
    },
    {
      key: 'ramFree', label: 'Server RAM free', value: i.memAvailableMb,
      display: n(i.memAvailableMb, ' MB'), level: gradeLow(i.memAvailableMb, 400, 200),
      healthy: 'over 400 MB', actAt: 'under 200 MB',
      playbook: 'Pause background jobs now; upgrade the Hetzner box (8 GB is about €15 a month).',
    },
    {
      key: 'cpuLoad', label: 'Server CPU load (per core)', value: loadPerCpu,
      display: loadPerCpu === null ? 'not measured' : `${loadPerCpu.toFixed(2)} × ${i.cpus} cores`,
      level: grade(loadPerCpu, 1, 1.5),
      healthy: 'under 1.0 per core', actAt: 'over 1.5 per core',
      playbook: 'Pause background jobs and turn the feed cache on; if it persists, upgrade the box.',
    },
    {
      key: 'disk', label: 'Server disk used', value: i.diskPct,
      display: n(i.diskPct, '%'), level: grade(i.diskPct, 75, 85),
      healthy: 'under 75%', actAt: 'over 85%',
      playbook: 'Check WAL and backup retention first (the usual cause); then add a volume.',
    },
    {
      key: 'activeJobs', label: 'Live jobs', value: i.activeJobs,
      display: n(i.activeJobs), level: grade(i.activeJobs, 200_000, 250_000),
      healthy: 'under 200,000', actAt: '250,000 (box upgrade trigger)',
      playbook: 'Upgrade the box before 250K: the vector index stops fitting in RAM.',
    },
    {
      key: 'embeddingBacklog', label: 'Jobs waiting for matching data', value: i.embeddingBacklog,
      display: n(i.embeddingBacklog), level: grade(i.embeddingBacklog, 50, 500),
      healthy: 'under 50', actAt: 'over 500',
      playbook: 'New jobs are not being matched yet. Pause non-essential jobs so embedding catches up; then move embedding off the box.',
    },
    {
      key: 'failingPipelines', label: 'Scheduled jobs failing or late', value: i.failingPipelines,
      display: n(i.failingPipelines), level: grade(i.failingPipelines, 1, 3),
      healthy: 'none', actAt: '3 or more',
      playbook: 'Open Pipelines to see which job and its last message.',
    },
    {
      key: 'healthCheck', label: 'Server health check last reported', value: i.healthCheckAgeMin,
      display: i.healthCheckAgeMin === null ? 'never' : `${Math.round(i.healthCheckAgeMin)} min ago`,
      level: i.healthCheckAgeMin === null ? 'red' : grade(i.healthCheckAgeMin, 20, 60),
      healthy: 'within 20 min', actAt: 'over an hour',
      playbook: 'The VPS health cron is not reporting: the server or its cron may be down. Check the watchdog email and SSH in.',
    },
  ];
}

/** The worst level among the signals, ignoring unknowns. */
export function overallLevel(signals: Signal[]): Level {
  const known = signals.map(s => s.level).filter(l => l !== 'unknown');
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
}

export async function getOverview(conn: Conn = db): Promise<Overview> {
  const count = (q: any) => one(conn, q, r => num(r.n), null as number | null);
  const [signups24h, signups7d, users, active7d, resumes, apps7d, feed, conns, health, jobs, backlog, failing, settings] = await Promise.all([
    count(sql`SELECT count(*)::int AS n FROM users WHERE "createdAt" > NOW() - INTERVAL '24 hours'`),
    count(sql`SELECT count(*)::int AS n FROM users WHERE "createdAt" > NOW() - INTERVAL '7 days'`),
    count(sql`SELECT count(*)::int AS n FROM users`),
    count(sql`SELECT count(DISTINCT user_id)::int AS n FROM activity_logs WHERE created_at > NOW() - INTERVAL '7 days'`),
    count(sql`SELECT count(*)::int AS n FROM candidate_users WHERE resume_url IS NOT NULL`),
    count(sql`SELECT count(*)::int AS n FROM job_applications WHERE applied_at > NOW() - INTERVAL '7 days'`),
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
    one(conn, sql`SELECT count(*)::int AS n FROM job_postings WHERE status = 'active' AND vector_embedding IS NULL`, r => num(r.n), null),
    // A pipeline is failing when its latest run was not ok.
    one(conn, sql`
      SELECT count(*)::int AS n FROM (
        SELECT DISTINCT ON (pipeline) pipeline, status FROM pipeline_runs
        WHERE started_at > NOW() - INTERVAL '3 days' ORDER BY pipeline, started_at DESC
      ) last WHERE status = 'error'`,
      r => num(r.n), null),
    getSettings(conn),
  ]);

  const s = health.stats || {};
  const signals = evaluateSignals({
    feedP95Ms: feed.p95, feedSamples: feed.n,
    dbConnections: conns.used, maxConnections: conns.max,
    memAvailableMb: num(s.memAvailableMb), load1: num(s.load1), cpus: num(s.cpus), diskPct: num(s.diskPct),
    activeJobs: num(jobs?.live), embeddingBacklog: backlog, failingPipelines: failing, healthCheckAgeMin: health.ageMin,
  });

  return {
    generatedAt: new Date().toISOString(),
    level: overallLevel(signals),
    today: {
      signups24h, signups7d, users, activeUsers7d: active7d, resumes, applications7d: apps7d,
      liveJobs: num(jobs?.live), jobsOpened24h: num(jobs?.opened), jobsClosed24h: num(jobs?.closed),
    },
    signals,
    settings,
  };
}
