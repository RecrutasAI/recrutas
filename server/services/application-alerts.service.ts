/**
 * Tell candidates what happened to jobs they applied to.
 *
 * Silence after applying is the top complaint job seekers have, and the most
 * common way an application ends is the job closing without anyone telling the
 * applicant. Recrutas re-reads every company board, so it can:
 *
 *   - closed:   the posting left the employer's board (snapshot expiry marks
 *               these liveness_status = 'removed'). Only that counts: jobs we
 *               close for our own housekeeping (age, dead links) are not a
 *               signal from the employer. A closure must hold for 24 hours,
 *               because ingestion reopens a job its board lists again.
 *   - reposted: after the candidate applied, the same company posted the same
 *               title in the same location as a new posting, and the one they
 *               applied to is gone. Often means the role is still open.
 *
 * Each application is alerted at most once per kind; the mark lives in
 * job_applications.metadata. Candidates get one in-app notification per
 * application and at most one email per run.
 */
import { db } from '../db';
import { sql } from 'drizzle-orm/sql';
import { applicationUpdatesDigestEmail, sendEmail } from '../lib/email';

export type AlertKind = 'closed' | 'reposted';

export interface ApplicationAlert {
  kind: AlertKind;
  applicationId: number;
  candidateId: string;
  jobId: number;
  title: string;
  company: string;
  appliedAt: Date;
  closedAt: Date | null;
  repostJobId?: number;
  repostedAt?: Date;
}

const OPEN_STATUSES = sql`('submitted', 'viewed', 'screening')`;

// The shared pool or a transaction (tests run against the real schema and roll back).
type Conn = { execute: typeof db.execute };

const rows = (r: any): any[] => (r?.rows ?? r) as any[];

export async function findClosedApplications(limit = 500, conn: Conn = db): Promise<ApplicationAlert[]> {
  const r = await conn.execute(sql`
    SELECT a.id AS application_id, a.candidate_id, a.applied_at, j.id AS job_id, j.title, j.company, j.updated_at AS closed_at
    FROM job_applications a
    JOIN job_postings j ON j.id = a.job_id
    WHERE j.status = 'closed'
      AND j.liveness_status = 'removed'
      AND j.updated_at < NOW() - INTERVAL '24 hours'
      AND j.updated_at > a.applied_at
      AND a.status IN ${OPEN_STATUSES}
      AND a.metadata->>'closureNotifiedAt' IS NULL
    ORDER BY j.updated_at
    LIMIT ${limit}`);
  return rows(r).map(x => ({
    kind: 'closed' as const,
    applicationId: x.application_id, candidateId: x.candidate_id, jobId: x.job_id,
    title: x.title, company: x.company, appliedAt: new Date(x.applied_at), closedAt: new Date(x.closed_at),
  }));
}

export async function findRepostedApplications(limit = 500, conn: Conn = db): Promise<ApplicationAlert[]> {
  const r = await conn.execute(sql`
    SELECT DISTINCT ON (a.id)
      a.id AS application_id, a.candidate_id, a.applied_at, j.id AS job_id, j.title, j.company, j.updated_at AS closed_at,
      n.id AS repost_job_id, n.created_at AS reposted_at
    FROM job_applications a
    JOIN job_postings j ON j.id = a.job_id
    JOIN job_postings n
      ON lower(n.company) = lower(j.company)
     AND lower(trim(n.title)) = lower(trim(j.title))
     AND lower(coalesce(n.location, '')) = lower(coalesce(j.location, ''))
     AND n.id <> j.id
     AND n.status = 'active'
     AND n.created_at > a.applied_at
    WHERE j.status = 'closed'
      AND j.liveness_status = 'removed'
      AND a.status IN ${OPEN_STATUSES}
      AND a.metadata->>'repostNotifiedAt' IS NULL
    ORDER BY a.id, n.created_at
    LIMIT ${limit}`);
  return rows(r).map(x => ({
    kind: 'reposted' as const,
    applicationId: x.application_id, candidateId: x.candidate_id, jobId: x.job_id,
    title: x.title, company: x.company, appliedAt: new Date(x.applied_at), closedAt: x.closed_at ? new Date(x.closed_at) : null,
    repostJobId: x.repost_job_id, repostedAt: new Date(x.reposted_at),
  }));
}

const fmtDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// Some boards store company names all lowercase ("lucid motors").
const displayCompany = (c: string) => (c === c.toLowerCase() ? c.replace(/\b\w/g, ch => ch.toUpperCase()) : c);

export function alertText(alert: ApplicationAlert): { title: string; message: string } {
  const a = { ...alert, company: displayCompany(alert.company), title: alert.title.trim() };
  if (a.kind === 'reposted') {
    return {
      title: `${a.company} reposted a role you applied to`,
      message: `You applied to ${a.title} on ${fmtDate(a.appliedAt)}. ${a.company} took that posting down and posted the same role again${a.repostedAt ? ` on ${fmtDate(a.repostedAt)}` : ''}. That often means they're still looking: you can reapply, reach out to the recruiter, or move on.`,
    };
  }
  return {
    title: `${a.title} at ${a.company} was taken down`,
    message: `You applied on ${fmtDate(a.appliedAt)}. ${a.company} removed the posting from its careers page${a.closedAt ? ` on ${fmtDate(a.closedAt)}` : ''}, so the role is most likely filled or paused. If you haven't heard back, it's time to focus elsewhere.`,
  };
}

interface Prefs { inApp: boolean; email: boolean }

async function preferencesFor(userIds: string[], conn: Conn): Promise<Map<string, Prefs>> {
  const out = new Map<string, Prefs>();
  if (userIds.length === 0) {return out;}
  const r = await conn.execute(sql`
    SELECT user_id, in_app_notifications, email_notifications, application_updates
    FROM notification_preferences
    WHERE user_id IN (${sql.join(userIds.map(u => sql`${u}::uuid`), sql`, `)})`);
  for (const p of rows(r)) {
    out.set(p.user_id, {
      inApp: p.in_app_notifications !== false && p.application_updates !== false,
      email: p.email_notifications !== false && p.application_updates !== false,
    });
  }
  return out;
}

export interface AlertRunStats { closed: number; reposted: number; notified: number; emailed: number; candidates: number }

/**
 * Find and deliver alerts. With apply=false it only reports what it would send.
 * A repost supersedes the closure alert for the same application in one run.
 */
export async function runApplicationAlerts(opts: { apply: boolean; log?: (s: string) => void; conn?: Conn; sendEmails?: boolean }): Promise<AlertRunStats> {
  const log = opts.log ?? (() => {});
  const conn = opts.conn ?? db;
  const sendEmails = opts.sendEmails ?? true;
  const reposted = await findRepostedApplications(500, conn);
  const repostedIds = new Set(reposted.map(a => a.applicationId));
  const closed = (await findClosedApplications(500, conn)).filter(a => !repostedIds.has(a.applicationId));
  const all = [...reposted, ...closed];
  const byCandidate = new Map<string, ApplicationAlert[]>();
  for (const a of all) {byCandidate.set(a.candidateId, [...(byCandidate.get(a.candidateId) ?? []), a]);}
  const stats: AlertRunStats = { closed: closed.length, reposted: reposted.length, notified: 0, emailed: 0, candidates: byCandidate.size };
  log(`[ApplicationAlerts] ${closed.length} closed, ${reposted.length} reposted, across ${byCandidate.size} candidate(s)`);
  if (!opts.apply || all.length === 0) {return stats;}

  const prefs = await preferencesFor([...byCandidate.keys()], conn);
  for (const [candidateId, alerts] of byCandidate) {
    const p = prefs.get(candidateId) ?? { inApp: true, email: true };
    for (const a of alerts) {
      const { title, message } = alertText(a);
      if (p.inApp) {
        await conn.execute(sql`
          INSERT INTO notifications (user_id, type, title, message, data, priority, related_job_id, related_application_id)
          VALUES (${candidateId}::uuid, ${a.kind === 'reposted' ? 'job_reposted' : 'job_closed'}, ${title}, ${message},
                  ${JSON.stringify({ jobTitle: a.title, companyName: a.company, repostJobId: a.repostJobId ?? null })}::jsonb,
                  'medium', ${a.jobId}, ${a.applicationId})`);
        stats.notified++;
      }
      // Mark even when in-app is off, so a later preference change doesn't
      // replay a backlog of stale alerts.
      const key = a.kind === 'reposted' ? 'repostNotifiedAt' : 'closureNotifiedAt';
      const marks: Record<string, string> = { [key]: new Date().toISOString() };
      if (a.kind === 'reposted') {marks.closureNotifiedAt = marks[key];}
      await conn.execute(sql`
        UPDATE job_applications
        SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(marks)}::jsonb
        WHERE id = ${a.applicationId}`);
    }
    if (p.email && sendEmails) {
      const ur = await conn.execute(sql`SELECT email, first_name FROM users WHERE id = ${candidateId}::uuid`);
      const user = rows(ur)[0];
      if (user?.email) {
        try {
          await sendEmail({
            to: user.email,
            subject: alerts.length === 1 ? alertText(alerts[0]).title : `Updates on ${alerts.length} jobs you applied to`,
            html: applicationUpdatesDigestEmail(user.first_name, alerts.map(a => ({ kind: a.kind, ...alertText(a) }))),
          });
          stats.emailed++;
        } catch (err) {
          log(`[ApplicationAlerts] email to ${candidateId} failed: ${(err as Error).message}`);
        }
      }
    }
  }
  return stats;
}
