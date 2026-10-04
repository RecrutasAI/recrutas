/**
 * Applications the extension saw a candidate submit.
 *
 * The extension reports a submission when it sees the application system's
 * own confirmation ("Thank you for applying"). It never reads what was typed
 * into the form. This turns that report into a job_applications row so the
 * candidate has a record of where they applied and Recrutas can tell them
 * what happened afterwards (posting taken down, reposted, no reply).
 *
 * The posting is matched to a job we already track by its URL, then by the
 * vendor's own job id (custom-domain Greenhouse boards change the URL but
 * keep the id). A posting we don't track gets a hidden placeholder job
 * (status 'paused', so it never enters the feed) to hang the record on.
 */
import { db } from '../db';
import { jobApplications, jobPostings } from '@shared/schema';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm/sql';
import { vendorJobId } from '../lib/ats-job-key';
import { ensureSystemUserExists } from './job-ingestion.service';

// Any drizzle executor: the shared pool, or a transaction (tests run the
// write path against the real schema inside a rolled-back transaction).
type Conn = Pick<typeof db, 'select' | 'insert'>;

const VENDOR_HOSTS: [string, RegExp][] = [
  ['greenhouse', /greenhouse\.io$/],
  ['lever', /lever\.co$/],
  ['ashby', /ashbyhq\.com$/],
  ['smartrecruiters', /smartrecruiters\.com$/],
  ['workable', /workable\.com$/],
  ['breezy', /breezy\.hr$/],
  ['recruitee', /recruitee\.com$/],
  ['workday', /myworkdayjobs\.com$|myworkdaysite\.com$/],
];

/** The application system a URL belongs to, or null. gh_jid marks a Greenhouse board on a company's own domain. */
export function vendorFromUrl(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.searchParams.has('gh_jid')) {return 'greenhouse';}
  const host = u.hostname.toLowerCase();
  return VENDOR_HOSTS.find(([, re]) => re.test(host))?.[0] ?? null;
}

/**
 * The posting's own URL, from any page of its application flow: drops the
 * query (except gh_jid), the fragment, and trailing form/confirmation steps
 * such as /apply, /application, /thanks, /confirmation.
 */
export function canonicalPostingUrl(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const ghJid = u.searchParams.get('gh_jid');
  u.search = ghJid ? `?gh_jid=${ghJid}` : '';
  u.hash = '';
  u.protocol = 'https:';
  u.pathname = u.pathname
    .replace(/\/+$/, '')
    .replace(/\/(apply|application|thanks|thank-you|confirmation|submitted|success)(\/.*)?$/i, '');
  return u.toString().replace(/\/+$/, '').replace(/\/\?/, '?');
}

/** The tracked job a posting URL belongs to, if any. */
export async function findJobForPostingUrl(url: string, conn: Conn = db): Promise<{ id: number; title: string; company: string } | null> {
  const canonical = canonicalPostingUrl(url);
  if (!canonical) {return null;}
  const variants = Array.from(new Set([canonical, `${canonical}/`, canonical.replace(/^https:/, 'http:')]));
  const [byUrl] = await conn.select({ id: jobPostings.id, title: jobPostings.title, company: jobPostings.company })
    .from(jobPostings)
    .where(sql`${jobPostings.externalUrl} IN (${sql.join(variants.map(v => sql`${v}`), sql`, `)})`)
    .limit(1);
  if (byUrl) {return byUrl;}

  const vendor = vendorFromUrl(url);
  const id = vendor ? vendorJobId(vendor, canonical) : null;
  if (!vendor || !id) {return null;}
  const [byId] = await conn.select({ id: jobPostings.id, title: jobPostings.title, company: jobPostings.company })
    .from(jobPostings)
    .where(sql`${jobPostings.source} IN (${`ATS:${vendor}`}, ${vendor}) AND ${jobPostings.externalId} LIKE ${`%::${id}`}`)
    .limit(1);
  return byId ?? null;
}

export interface ReportedApplication {
  postingUrl: string;
  title?: string;
  company?: string;
  autoFilled?: boolean;
}

export interface RecordResult {
  applicationId: number;
  jobId: number;
  tracked: boolean;     // true when the posting is one we monitor (closure/repost alerts apply)
  duplicate: boolean;   // already recorded before
  appliedAt: Date | null;
}

/** Record a submission the extension saw. Idempotent per candidate + job. */
export async function recordReportedApplication(candidateId: string, report: ReportedApplication, conn: Conn = db): Promise<RecordResult | null> {
  const canonical = canonicalPostingUrl(report.postingUrl);
  if (!canonical) {return null;}

  let job = await findJobForPostingUrl(canonical, conn);
  const tracked = !!job;
  if (!job) {
    const title = (report.title || '').trim().slice(0, 200);
    const company = (report.company || '').trim().slice(0, 200);
    if (!title || !company) {return null;}
    const owner = await ensureSystemUserExists();
    const externalId = `candidate_reported::${canonical}`;
    // Placeholder for a posting we don't scrape. 'paused' keeps it out of the
    // feed; the purge skips jobs that have applications.
    await conn.insert(jobPostings).values({
      talentOwnerId: owner,
      title,
      company,
      description: '',
      source: 'candidate_reported',
      externalId,
      externalUrl: canonical,
      status: 'paused',
    } as any).onConflictDoNothing();
    const [row] = await conn.select({ id: jobPostings.id, title: jobPostings.title, company: jobPostings.company })
      .from(jobPostings)
      .where(and(eq(jobPostings.externalId, externalId), eq(jobPostings.source, 'candidate_reported')))
      .limit(1);
    if (!row) {return null;}
    job = row;
  }

  const [existing] = await conn.select({ id: jobApplications.id, appliedAt: jobApplications.appliedAt })
    .from(jobApplications)
    .where(and(eq(jobApplications.jobId, job.id), eq(jobApplications.candidateId, candidateId)))
    .limit(1);
  if (existing) {
    return { applicationId: existing.id, jobId: job.id, tracked, duplicate: true, appliedAt: existing.appliedAt };
  }

  const [created] = await conn.insert(jobApplications).values({
    jobId: job.id,
    candidateId,
    status: 'submitted',
    autoFilled: !!report.autoFilled,
    metadata: { source: 'extension', postingUrl: canonical, detectedAt: new Date().toISOString() },
  }).onConflictDoNothing().returning({ id: jobApplications.id, appliedAt: jobApplications.appliedAt });
  if (!created) {
    // Lost a race with a parallel report: read the winner.
    const [again] = await conn.select({ id: jobApplications.id, appliedAt: jobApplications.appliedAt })
      .from(jobApplications)
      .where(and(eq(jobApplications.jobId, job.id), eq(jobApplications.candidateId, candidateId)))
      .limit(1);
    return again ? { applicationId: again.id, jobId: job.id, tracked, duplicate: true, appliedAt: again.appliedAt } : null;
  }
  return { applicationId: created.id, jobId: job.id, tracked, duplicate: false, appliedAt: created.appliedAt };
}

/** Whether the candidate already applied to the posting at this URL. */
export async function applicationForUrl(candidateId: string, url: string, conn: Conn = db): Promise<{ appliedAt: Date | null; jobId: number } | null> {
  const job = await findJobForPostingUrl(url, conn);
  if (!job) {return null;}
  const [row] = await conn.select({ appliedAt: jobApplications.appliedAt })
    .from(jobApplications)
    .where(and(eq(jobApplications.jobId, job.id), eq(jobApplications.candidateId, candidateId)))
    .limit(1);
  return row ? { appliedAt: row.appliedAt, jobId: job.id } : null;
}
