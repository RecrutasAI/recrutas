/**
 * The weekly summary: one email a week that tells an active candidate what
 * happened with their search, so the silence after applying has an answer.
 *
 *   - what they applied to this week
 *   - what happened to their applications this week (taken down, reposted,
 *     replies) and what's still waiting
 *   - new jobs posted this week that they qualify for (verdict = Apply)
 *   - the diagnosis's next step
 *
 * Sent only to candidates who used Recrutas in the last 30 days (visited the
 * feed or applied) and have a parsed resume, at most once every 6 days
 * (a 'weekly_summary' notification marks it), and never when the week has
 * nothing worth saying.
 */
import { db } from '../db';
import { sql } from 'drizzle-orm/sql';
import { storage } from '../storage';
import { diagnoseCandidate } from './application-diagnosis.service';
import { sendEmail, weeklySummaryEmail } from '../lib/email';

const rows = (r: any): any[] => (r?.rows ?? r) as any[];
const titleCase = (c: string) => (c === c.toLowerCase() ? c.replace(/\b\w/g, ch => ch.toUpperCase()) : c);

export interface WeeklySummary {
  appliedThisWeek: Array<{ title: string; company: string }>;
  updates: Array<{ kind: 'taken_down' | 'reposted' | 'replied'; title: string; company: string }>;
  waiting: number;
  waitingPastFollowUp: number;
  newApplyMatches: number;
  topMatches: Array<{ title: string; company: string; location: string | null }>;
  nextStep: string | null;
}

export function hasNews(s: WeeklySummary): boolean {
  return s.appliedThisWeek.length > 0 || s.updates.length > 0 || s.newApplyMatches > 0;
}

export function summarySubject(s: WeeklySummary): string {
  const parts: string[] = [];
  if (s.appliedThisWeek.length) {parts.push(`${s.appliedThisWeek.length} application${s.appliedThisWeek.length === 1 ? '' : 's'}`);}
  if (s.updates.length) {parts.push(`${s.updates.length} update${s.updates.length === 1 ? '' : 's'}`);}
  if (s.newApplyMatches) {parts.push(`${s.newApplyMatches} new job${s.newApplyMatches === 1 ? '' : 's'} you qualify for`);}
  return parts.length ? `Your week: ${parts.join(', ')}` : 'Your week on Recrutas';
}

export async function buildWeeklySummary(candidateId: string): Promise<WeeklySummary> {
  const applied = rows(await db.execute(sql`
    SELECT j.title, j.company FROM job_applications a JOIN job_postings j ON j.id = a.job_id
    WHERE a.candidate_id = ${candidateId}::uuid AND a.applied_at > NOW() - INTERVAL '7 days'
    ORDER BY a.applied_at DESC LIMIT 10`)).map(r => ({ title: String(r.title).trim(), company: titleCase(r.company) }));

  // Changes this week to any of their applications: taken down, reposted, or an employer response.
  const updates = rows(await db.execute(sql`
    SELECT j.title, j.company,
      CASE
        WHEN a.metadata->>'repostNotifiedAt' > (NOW() - INTERVAL '7 days')::text THEN 'reposted'
        WHEN a.status IN ('viewed', 'screening', 'interview_scheduled', 'interview_completed', 'offer', 'rejected')
             AND a.last_status_update > NOW() - INTERVAL '7 days' THEN 'replied'
        WHEN j.status = 'closed' AND j.liveness_status = 'removed' AND j.updated_at > NOW() - INTERVAL '7 days' THEN 'taken_down'
      END AS kind
    FROM job_applications a JOIN job_postings j ON j.id = a.job_id
    WHERE a.candidate_id = ${candidateId}::uuid`))
    .filter(r => r.kind)
    .map(r => ({ kind: r.kind, title: String(r.title).trim(), company: titleCase(r.company) }));

  const diagnosis = await diagnoseCandidate(candidateId);

  // New jobs from the past week they qualify for, from the same feed (and verdicts) they see.
  let newApplyMatches = 0;
  let topMatches: WeeklySummary['topMatches'] = [];
  try {
    const feed = await storage.getJobRecommendations(candidateId, { postedWithinDays: 7 } as any, { page: 1, limit: 100 });
    // "Qualify" must be true: an Apply verdict with an unanswered requirement
    // (e.g. citizenship the candidate hasn't stated) isn't confirmed, so it
    // doesn't count here.
    const apply = (feed.jobs || []).filter((j: any) => j.verdict?.label === 'apply' && !(j.verdict.toCheck?.length));
    newApplyMatches = apply.length;
    topMatches = apply.slice(0, 3).map((j: any) => ({ title: String(j.title).trim(), company: titleCase(j.company), location: j.location ?? null }));
  } catch {
    // A slow or failed feed doesn't block the rest of the summary.
  }

  return {
    appliedThisWeek: applied,
    updates,
    waiting: diagnosis.answers.waiting,
    waitingPastFollowUp: diagnosis.answers.waitingPastFollowUp,
    newApplyMatches,
    topMatches,
    nextStep: diagnosis.enoughData ? diagnosis.nextStep.text : null,
  };
}

/** Candidates to consider: active in the last 30 days, with a parsed resume, not sent in the last 6 days. */
export async function eligibleCandidates(limit = 200): Promise<Array<{ id: string; email: string; firstName: string | null }>> {
  return rows(await db.execute(sql`
    SELECT u.id, u.email, u.first_name
    FROM candidate_users c JOIN users u ON u.id = c.user_id
    LEFT JOIN notification_preferences p ON p.user_id = u.id
    WHERE u.email IS NOT NULL
      AND jsonb_array_length(COALESCE(c.skills, '[]'::jsonb)) > 0
      AND (c.last_feed_visit > NOW() - INTERVAL '30 days'
           OR EXISTS (SELECT 1 FROM job_applications a WHERE a.candidate_id = u.id AND a.applied_at > NOW() - INTERVAL '30 days'))
      AND COALESCE(p.email_notifications, true) AND COALESCE(p.application_updates, true)
      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.type = 'weekly_summary'
                      AND n.created_at > NOW() - INTERVAL '6 days')
    ORDER BY u.id
    LIMIT ${limit}`)).map(r => ({ id: r.id, email: r.email, firstName: r.first_name }));
}

export interface WeeklyRunStats { considered: number; sent: number; skippedNoNews: number; failed: number }

export async function runWeeklySummaries(opts: { apply: boolean; log?: (s: string) => void }): Promise<WeeklyRunStats> {
  const log = opts.log ?? (() => {});
  const candidates = await eligibleCandidates();
  const stats: WeeklyRunStats = { considered: candidates.length, sent: 0, skippedNoNews: 0, failed: 0 };
  for (const c of candidates) {
    try {
      const summary = await buildWeeklySummary(c.id);
      if (!hasNews(summary)) {stats.skippedNoNews++; continue;}
      const subject = summarySubject(summary);
      log(`[WeeklySummary] ${opts.apply ? 'send' : 'would send'} to ${c.id.slice(0, 8)}: ${subject}`);
      if (!opts.apply) {continue;}
      await sendEmail({ to: c.email, subject, html: weeklySummaryEmail(c.firstName, summary) });
      // In-app copy, and the marker that stops a second send this week.
      await db.execute(sql`
        INSERT INTO notifications (user_id, type, title, message, data, priority)
        VALUES (${c.id}::uuid, 'weekly_summary', ${subject},
                ${summary.nextStep ?? `${summary.newApplyMatches} new jobs you qualify for this week.`},
                ${JSON.stringify(summary)}::jsonb, 'low')`);
      stats.sent++;
    } catch (err) {
      stats.failed++;
      log(`[WeeklySummary] ${c.id.slice(0, 8)} failed: ${(err as Error).message}`);
    }
  }
  return stats;
}
