/**
 * The weekly numbers (gtm-plan A4): what the GTM agent's Monday [REPORT] is built from.
 *
 * Real accounts only (server/lib/real-users.ts). Activation is the admin console's ordered funnel
 * (the same people, in order: sign-up → resume → feed → autofill) for people who signed up in the
 * window, overall and per sign-up channel (users.signup_source, the prefix of the ?code= a launch link carries).
 * A number we couldn't read is null and printed as "not available", never 0.
 */
import { sql } from 'drizzle-orm/sql';
import { db } from '../db';
import { realUserIds } from '../lib/real-users';
import { activationForIds, type ActivationStep } from './admin-insights.service';

type Conn = { execute: typeof db.execute };
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

export interface ChannelRow { channel: string; signups: number; activated: number | null; codes: string[] }

export interface WeeklyNumbers {
  generatedAt: string;
  weekStart: string;                 // the 7 days ending at generatedAt
  signups: { thisWeek: number; priorWeek: number; total: number };
  resumes: { thisWeekSignups: number; ofThem: number; last30Signups: number; last30OfThem: number };
  applications: { thisWeek: number; priorWeek: number };
  activation: { last7: ActivationStep[] | null; last30: ActivationStep[] | null };
  channels: ChannelRow[];            // sign-ups in the last 30 days
  supply: { catalogJobs: number | null; catalogAt: string | null; directActive: number };
}

export async function collectWeeklyNumbers(conn: Conn = db, now = new Date()): Promise<WeeklyNumbers> {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const twoWeeksAgo = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const real = sql`role IS DISTINCT FROM 'system' AND id IN ${realUserIds}`;

  const [u] = rows(await conn.execute(sql`
    SELECT count(*) FILTER (WHERE "createdAt" >= ${weekAgo})::int AS this_week,
           count(*) FILTER (WHERE "createdAt" >= ${twoWeeksAgo} AND "createdAt" < ${weekAgo})::int AS prior_week,
           count(*)::int AS total
    FROM users WHERE ${real}`));
  const [r] = rows(await conn.execute(sql`
    SELECT count(*) FILTER (WHERE u."createdAt" >= ${weekAgo})::int AS week_signups,
           count(*) FILTER (WHERE u."createdAt" >= ${weekAgo} AND EXISTS (SELECT 1 FROM activity_logs a WHERE a.user_id = u.id AND a.type = 'resume_parsing_complete'))::int AS week_resumes,
           count(*)::int AS month_signups,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM activity_logs a WHERE a.user_id = u.id AND a.type = 'resume_parsing_complete'))::int AS month_resumes
    FROM users u WHERE u."createdAt" >= ${monthAgo} AND u.role IS DISTINCT FROM 'system' AND u.id IN ${realUserIds}`));
  const [a] = rows(await conn.execute(sql`
    SELECT count(*) FILTER (WHERE applied_at >= ${weekAgo})::int AS this_week,
           count(*) FILTER (WHERE applied_at >= ${twoWeeksAgo} AND applied_at < ${weekAgo})::int AS prior_week
    FROM job_applications WHERE applied_at >= ${twoWeeksAgo} AND candidate_id IN ${realUserIds}`));
  const [catalog] = rows(await conn.execute(sql`SELECT jobs, computed_at FROM catalog_stats WHERE id = 1`).catch(() => []));
  const [direct] = rows(await conn.execute(sql`SELECT count(*)::int AS n FROM job_postings WHERE status = 'active'`));

  const recent = rows(await conn.execute(sql`
    SELECT id::text AS id, COALESCE(NULLIF(lower(signup_source), ''), 'none') AS channel, invite_code_used AS code
    FROM users WHERE "createdAt" >= ${monthAgo} AND ${real}`));

  // One PostHog query at a time: parallel queries timed out on 2026-10-09.
  const safely = async (ids: string[] | null, days: number) => {
    try { return await activationForIds(ids, days, conn); } catch (err) { console.warn('[weekly-numbers] PostHog:', (err as Error).message); return null; }
  };
  const last7 = await safely(null, 7);
  const last30 = await safely(null, 30);
  const channels: ChannelRow[] = [];
  for (const [channel, members] of groupBy(recent, x => String(x.channel))) {
    const steps = await safely(members.map(m => String(m.id)), 30);
    channels.push({
      channel,
      signups: members.length,
      activated: steps ? steps[steps.length - 1].people : null,
      codes: [...new Set(members.map(m => m.code).filter(Boolean).map(String))].sort(),
    });
  }
  channels.sort((x, y) => y.signups - x.signups || x.channel.localeCompare(y.channel));

  return {
    generatedAt: now.toISOString(),
    weekStart: weekAgo.slice(0, 10),
    signups: { thisWeek: u?.this_week ?? 0, priorWeek: u?.prior_week ?? 0, total: u?.total ?? 0 },
    resumes: { thisWeekSignups: r?.week_signups ?? 0, ofThem: r?.week_resumes ?? 0, last30Signups: r?.month_signups ?? 0, last30OfThem: r?.month_resumes ?? 0 },
    applications: { thisWeek: a?.this_week ?? 0, priorWeek: a?.prior_week ?? 0 },
    activation: { last7, last30 },
    channels,
    supply: {
      catalogJobs: catalog ? Number(catalog.jobs) : null,
      catalogAt: catalog?.computed_at ? new Date(catalog.computed_at).toISOString() : null,
      directActive: direct?.n ?? 0,
    },
  };
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {m.set(key(it), [...(m.get(key(it)) ?? []), it]);}
  return m;
}

const pct = (a: number, b: number): string => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');
const n = (v: number | null | undefined): string => (v === null || v === undefined ? 'not available' : v.toLocaleString('en-US'));

function funnelLines(steps: ActivationStep[] | null): string[] {
  if (!steps) {return ['- not available (PostHog did not answer)'];}
  return steps.map((s, i) => (i === 0
    ? `- ${s.label}: **${s.people}**`
    : `- ${s.label}: **${s.people}** (${s.fromPrevious ?? '—'}% of the step before, ${s.fromStart ?? '—'}% of sign-ups)`));
}

export function weeklyMarkdown(w: WeeklyNumbers): string {
  const act7 = w.activation.last7, act30 = w.activation.last30;
  const activated = (s: ActivationStep[] | null) => (s ? s[s.length - 1].people : null);
  return [
    `# Weekly numbers: ${w.weekStart} to ${w.generatedAt.slice(0, 10)}`,
    '',
    'Real accounts only (test sign-ups excluded). Activated = the same person signed up, uploaded a resume, opened their feed and used autofill, in that order, within 30 days.',
    '',
    '## Sign-ups',
    `- This week: **${w.signups.thisWeek}** (the week before: ${w.signups.priorWeek})`,
    `- All time: ${w.signups.total}`,
    '',
    '## Resume rate',
    `- This week's sign-ups who uploaded a resume: **${w.resumes.ofThem} of ${w.resumes.thisWeekSignups}** (${pct(w.resumes.ofThem, w.resumes.thisWeekSignups)})`,
    `- Last 30 days: ${w.resumes.last30OfThem} of ${w.resumes.last30Signups} (${pct(w.resumes.last30OfThem, w.resumes.last30Signups)})`,
    '',
    '## Activation, same people in order',
    `Last 7 days: ${act7 ? `**${activated(act7)} activated**` : 'not available'}`,
    ...funnelLines(act7),
    '',
    `Last 30 days: ${act30 ? `**${activated(act30)} activated**` : 'not available'}`,
    ...funnelLines(act30),
    '',
    '## Activated by channel (sign-ups in the last 30 days)',
    ...(w.channels.length
      ? ['| Channel | Sign-ups | Activated | Codes |', '|---|---|---|---|',
        ...w.channels.map(c => `| ${c.channel} | ${c.signups} | ${n(c.activated)} | ${c.codes.join(', ') || '—'} |`)]
      : ['- No sign-ups in the last 30 days.']),
    '',
    '## Applications (marked applied in Recrutas)',
    `- This week: **${w.applications.thisWeek}** (the week before: ${w.applications.priorWeek})`,
    '',
    '## Supply',
    `- Jobs in the catalog (homepage number): **${n(w.supply.catalogJobs)}**${w.supply.catalogAt ? ` as of ${w.supply.catalogAt.slice(0, 16).replace('T', ' ')} UTC` : ''}`,
    `- Direct jobs live in the app database: ${n(w.supply.directActive)}`,
    '',
  ].join('\n');
}
