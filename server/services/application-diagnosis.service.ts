/**
 * "Why am I hearing nothing?" — a diagnosis of one candidate's own applications.
 *
 * Built only from facts Recrutas has, never generic advice:
 *   - answers:  how many got any reply, were taken down, reposted, or are
 *               still waiting (and how long)
 *   - timing:   how old each posting was when they applied, against how long
 *               that company's postings usually stay up (from daily board
 *               snapshots; global median when the company has too few)
 *   - fit:      how many were Stretch or Skip under the honest verdict
 *
 * and one next step, chosen by whichever problem is biggest. Below
 * MIN_APPLICATIONS it says so instead of guessing.
 */
import { db } from '../db';
import { sql } from 'drizzle-orm/sql';
import { extractHardRequirements, verdictFor, yearsFromPositions, type CandidateFacts, type VerdictLabel } from '../lib/hard-requirements';

export const MIN_APPLICATIONS = 3;
const FOLLOW_UP_AFTER_DAYS = 14;
const ANSWERED = new Set(['screening', 'interview_scheduled', 'interview_completed', 'offer', 'rejected', 'viewed']);

const rows = (r: any): any[] => (r?.rows ?? r) as any[];
// The shared pool or a transaction (tests run against the real schema and roll back).
type Conn = { execute: typeof db.execute };
const DAY = 864e5;

export interface DiagnosedApplication {
  appliedAt: Date;
  postedAt: Date | null;            // when Recrutas first saw the posting
  company: string;
  status: string;
  postingState: 'live' | 'taken_down' | 'unknown';
  reposted: boolean;
  verdict: VerdictLabel | null;
  verdictReason: string | null;
  companyMedianDays: number | null; // how long this company's postings usually stay up
}

export interface Diagnosis {
  applications: number;
  enoughData: boolean;
  answers: { replied: number; takenDown: number; reposted: number; waiting: number; waitingPastFollowUp: number };
  timing: { medianAgeWhenApplied: number | null; typicalLifetimeDays: number | null; appliedLate: number } | null;
  fit: { stretch: number; skip: number; topReason: string | null } | null;
  findings: string[];
  nextStep: { kind: 'apply_earlier' | 'better_fit' | 'follow_up' | 'keep_going' | 'need_data'; text: string };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) {return null;}
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Pure: turn a candidate's applications into the diagnosis. `globalLifetimeDays`
 * is the median days a posting stays up across all boards.
 */
export function diagnose(apps: DiagnosedApplication[], globalLifetimeDays: number | null, now = new Date()): Diagnosis {
  const n = apps.length;
  const replied = apps.filter(a => ANSWERED.has(a.status)).length;
  const reposted = apps.filter(a => !ANSWERED.has(a.status) && a.reposted).length;
  const takenDown = apps.filter(a => !ANSWERED.has(a.status) && !a.reposted && a.postingState === 'taken_down').length;
  const waitingApps = apps.filter(a => !ANSWERED.has(a.status) && !a.reposted && a.postingState !== 'taken_down' && !['withdrawn', 'offer'].includes(a.status));
  const waitingPastFollowUp = waitingApps.filter(a => now.getTime() - a.appliedAt.getTime() > FOLLOW_UP_AFTER_DAYS * DAY).length;
  const answers = { replied, takenDown, reposted, waiting: waitingApps.length, waitingPastFollowUp };

  if (n < MIN_APPLICATIONS) {
    return {
      applications: n, enoughData: false, answers, timing: null, fit: null, findings: [],
      nextStep: { kind: 'need_data', text: `After ${MIN_APPLICATIONS} applications, we'll show you what's working and what isn't. Apply through the extension and they're tracked automatically.` },
    };
  }

  const ages = apps.filter(a => a.postedAt).map(a => Math.max(0, (a.appliedAt.getTime() - a.postedAt!.getTime()) / DAY));
  const lateFlags = apps.filter(a => a.postedAt).map(a => {
    const life = a.companyMedianDays ?? globalLifetimeDays;
    return life != null && (a.appliedAt.getTime() - a.postedAt!.getTime()) / DAY > life;
  });
  const appliedLate = lateFlags.filter(Boolean).length;
  const timing = ages.length ? {
    medianAgeWhenApplied: Math.round(median(ages)!),
    typicalLifetimeDays: globalLifetimeDays != null ? Math.round(globalLifetimeDays) : null,
    appliedLate,
  } : null;

  const judged = apps.filter(a => a.verdict);
  const stretch = judged.filter(a => a.verdict === 'stretch').length;
  const skip = judged.filter(a => a.verdict === 'skip').length;
  const reasonCounts = new Map<string, number>();
  for (const a of judged) {
    if (a.verdict !== 'apply' && a.verdictReason) {reasonCounts.set(a.verdictReason, (reasonCounts.get(a.verdictReason) ?? 0) + 1);}
  }
  const topReason = [...reasonCounts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  const fit = judged.length ? { stretch, skip, topReason } : null;

  const findings: string[] = [];
  findings.push(replied > 0
    ? `${replied} of your ${n} applications got a reply.`
    : `None of your ${n} applications has had a reply yet.`);
  if (takenDown) {findings.push(`${takenDown} ${takenDown === 1 ? 'job was' : 'jobs were'} taken down by the company, most likely filled.`);}
  if (reposted) {findings.push(`${reposted} ${reposted === 1 ? 'job was' : 'jobs were'} taken down and posted again: the company may still be looking.`);}
  if (waitingPastFollowUp) {findings.push(`${waitingPastFollowUp} ${waitingPastFollowUp === 1 ? 'is' : 'are'} still posted with no reply after ${FOLLOW_UP_AFTER_DAYS}+ days.`);}
  if (timing && timing.medianAgeWhenApplied != null && appliedLate > 0) {
    findings.push(`${appliedLate} of ${ages.length} postings had been up longer than that company's postings usually last when you applied (typically ${timing.typicalLifetimeDays ?? '?'} days after they first appear). Your median: ${timing.medianAgeWhenApplied} days.`);
  }
  if (fit && stretch + skip > 0) {
    findings.push(`${stretch + skip} of ${judged.length} were a stretch or a mismatch on stated requirements${topReason ? ` (most often: ${topReason.toLowerCase()})` : ''}.`);
  }

  // One next step: the biggest problem first.
  const lateShare = ages.length ? appliedLate / ages.length : 0;
  const misfitShare = judged.length ? (stretch + skip) / judged.length : 0;
  let nextStep: Diagnosis['nextStep'];
  if (lateShare >= 0.5) {
    nextStep = { kind: 'apply_earlier', text: `Apply sooner: ${appliedLate} of ${ages.length} of your applications went to postings that were already past their usual life. Filter your feed to "Past 3 days" and apply to new matches first.` };
  } else if (misfitShare >= 0.4) {
    nextStep = { kind: 'better_fit', text: `Aim closer: ${stretch + skip} of ${judged.length} of your applications were a stretch on stated requirements. Filter your feed to "Apply" to focus on jobs you clearly qualify for.` };
  } else if (waitingPastFollowUp > 0) {
    nextStep = { kind: 'follow_up', text: `Follow up: ${waitingPastFollowUp} ${waitingPastFollowUp === 1 ? 'application is' : 'applications are'} past ${FOLLOW_UP_AFTER_DAYS} days with the job still posted. A short note to the recruiter is worth sending now.` };
  } else {
    nextStep = { kind: 'keep_going', text: 'Your applications are well timed and well matched. Replies take time; keep applying to new Apply matches.' };
  }

  return { applications: n, enoughData: true, answers, timing, fit, findings, nextStep };
}

// Median posting lifetime, cached per process (the query scans every removed
// posting; it changes slowly). Excludes duplicate-cleanup closures (no URL).
let lifetimeCache: { at: number; global: number | null } | null = null;
async function globalLifetimeDays(conn: Conn): Promise<number | null> {
  if (lifetimeCache && Date.now() - lifetimeCache.at < 6 * 3600e3) {return lifetimeCache.global;}
  const r = rows(await conn.execute(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (updated_at - created_at)) / 86400) AS d
    FROM job_postings
    WHERE status = 'closed' AND liveness_status = 'removed' AND external_url IS NOT NULL
      AND updated_at > NOW() - INTERVAL '60 days'`));
  const global = r[0]?.d != null ? Number(r[0].d) : null;
  lifetimeCache = { at: Date.now(), global };
  return global;
}

export async function diagnoseCandidate(candidateId: string, conn: Conn = db): Promise<Diagnosis> {
  const apps = rows(await conn.execute(sql`
    SELECT a.status, a.applied_at, a.metadata, j.company, j.created_at, j.status AS job_status,
           j.liveness_status, j.description, a.metadata->>'repostNotifiedAt' AS reposted_at
    FROM job_applications a JOIN job_postings j ON j.id = a.job_id
    WHERE a.candidate_id = ${candidateId}::uuid
    ORDER BY a.applied_at DESC
    LIMIT 200`));
  const prof = rows(await conn.execute(sql`
    SELECT job_preferences->'applicationAnswers' AS answers, resume_parsing_data->'positions' AS positions
    FROM candidate_users WHERE user_id = ${candidateId}::uuid`))[0] ?? {};
  const answers = prof.answers || {};
  const facts: CandidateFacts = {
    usCitizen: answers.usCitizen, needsSponsorship: answers.needsSponsorship,
    workAuthorizedUS: answers.workAuthorizedUS, securityClearance: answers.securityClearance,
    years: yearsFromPositions(prof.positions),
  };

  const companies = [...new Set(apps.map(a => String(a.company || '').toLowerCase()).filter(Boolean))];
  const companyMedians = new Map<string, number>();
  if (companies.length) {
    for (const c of rows(await conn.execute(sql`
      SELECT lower(company) AS company, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (updated_at - created_at)) / 86400) AS d
      FROM job_postings
      WHERE status = 'closed' AND liveness_status = 'removed' AND external_url IS NOT NULL
        AND updated_at > NOW() - INTERVAL '60 days'
        AND lower(company) IN (${sql.join(companies.map(c => sql`${c}`), sql`, `)})
      GROUP BY lower(company) HAVING count(*) >= 20`))) {
      companyMedians.set(c.company, Number(c.d));
    }
  }

  const diagnosed: DiagnosedApplication[] = apps.map(a => {
    // Placeholders for postings we don't scrape have no description: no verdict.
    const v = a.description ? verdictFor(extractHardRequirements(a.description), facts, 70) : null;
    return {
      appliedAt: new Date(a.applied_at),
      postedAt: a.created_at ? new Date(a.created_at) : null,
      company: a.company,
      status: a.status,
      postingState: a.job_status === 'closed' && a.liveness_status === 'removed' ? 'taken_down' : a.job_status === 'active' ? 'live' : 'unknown',
      reposted: !!a.reposted_at,
      verdict: v?.label ?? null,
      verdictReason: v?.reasons[0] ?? null,
      companyMedianDays: companyMedians.get(String(a.company || '').toLowerCase()) ?? null,
    };
  });
  return diagnose(diagnosed, await globalLifetimeDays(conn));
}
