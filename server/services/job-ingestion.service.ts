/**
 * Job Ingestion Service
 * Persists external jobs to database with deduplication
 */

import { createHash } from 'crypto';
import { db } from '../db';
import { jobPostings, users } from '@shared/schema';
import { eq, and, or } from 'drizzle-orm';
import { gt } from 'drizzle-orm/sql/expressions';
import { sql } from 'drizzle-orm/sql';
import { normalizeSkills, SKILL_ALIASES } from '../skill-normalizer';
import { classifyWorkType } from '../lib/work-type';

/** Extract canonical skills from free-form text using the full alias taxonomy. */
function extractSkillsFromText(text: string): string[] {
  if (!text) {return [];}
  const words = text.split(/[\s,;|•·()[\]{}<>]+/).filter(w => w.length > 0);
  const found = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      const phrase = words.slice(i, i + n).join(' ').toLowerCase();
      const canonical = SKILL_ALIASES[phrase];
      if (canonical) {found.add(canonical);}
    }
  }
  return Array.from(found).slice(0, 20);
}

// System user UUID for external jobs (well-known constant)
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

// Ensure system user exists for external job ownership
async function ensureSystemUserExists(): Promise<string> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.id, SYSTEM_USER_ID))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(users).values({
      id: SYSTEM_USER_ID,
      name: 'External Jobs System',
      email: 'system@recrutas.internal',
      emailVerified: true,
      role: 'system',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log('[JobIngestion] Created system user for external jobs');
  }

  return SYSTEM_USER_ID;
}

export interface ExternalJobInput {
  title: string;
  company: string;
  location: string;
  description: string;
  requirements: string[];
  skills: string[];
  workType: 'remote' | 'hybrid' | 'onsite';
  salaryMin?: number;
  salaryMax?: number;
  source: string;
  externalId: string;
  externalUrl: string;
  careerPageUrl?: string;
  postedDate: string;
}

function getSourceTrustScore(source: string): number {
  const trustScores: Record<string, number> = {
    'greenhouse': 95,
    'lever': 95,
    'workday': 90,
    'company-api': 95,
    'jsearch': 70,
    'remoteok': 75,
    'themuse': 70,
    'arbeitnow': 65,
    'usajobs': 85,
    'default': 50
  };
  return trustScores[source.toLowerCase()] || trustScores.default;
}

/**
 * Mirror of the SQL `jobPostUrlRequirement` in storage.ts. A URL is considered
 * a real job-post page if it isn't a bare-domain root and contains a
 * job-id-like marker (≥4 digits in the path/query, an ATS query param, a
 * /job/ or /jobs/<long-slug> segment) or matches a known ATS host.
 *
 * Used by the ingestion chokepoint to reject homepage/careers-landing URLs
 * before they ever reach the DB. Keep in sync with server/storage.ts.
 */
export function isJobPostUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (/^https?:\/\/[^/]+\/?$/.test(url)) return false;
  if (/[/?][^/?#]*\d{4,}/.test(url)) return true;
  if (/(gh_jid|jobid|requisition|posting|\/job\/|\/jobs\/[a-z0-9_-]{8,})/i.test(url)) return true;
  if (/(boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com|\.recruitee\.com|\.workable\.com|\.bamboohr\.com|myworkdayjobs\.com|smartrecruiters\.com|icims\.com|taleo\.net)/i.test(url)) return true;
  return false;
}

export class JobIngestionService {
  async ingestExternalJobs(jobs: ExternalJobInput[]): Promise<{ inserted: number; duplicates: number; errors: number; skippedNonUS: number; skippedBadUrl: number }> {
    const stats = { inserted: 0, duplicates: 0, errors: 0, skippedNonUS: 0, skippedBadUrl: 0 };
    console.log(`[JobIngestion] Processing ${jobs.length} external jobs...`);

    const systemUserId = await ensureSystemUserExists();
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + 60);

    // No location-based hard filter at ingest. Non-US jobs are ranked last
    // by usPriorityOrder in storage.ts (US first, then unknown, then non-US),
    // so they appear at the bottom of the feed instead of being dropped.
    // Keep the stat field for backward compatibility but it stays at 0.
    const usJobs = jobs;

    // Ingestion URL contract: every job must have a real job-post URL.
    // Homepage / careers-landing / bare-domain URLs are rejected here so the
    // feed never has to filter them out downstream (see project_ingestion_url_contract).
    const sampleBadUrls: string[] = [];
    const validJobs = usJobs.filter(job => {
      if (isJobPostUrl(job.externalUrl)) return true;
      stats.skippedBadUrl++;
      if (sampleBadUrls.length < 5) sampleBadUrls.push(`${job.source}: ${job.externalUrl ?? '(null)'}`);
      return false;
    });
    if (stats.skippedBadUrl > 0) {
      console.log(`[JobIngestion] Rejected ${stats.skippedBadUrl} jobs with non-job-post URL. Sample:`);
      for (const s of sampleBadUrls) console.log(`  ${s}`);
    }

    // Assign deterministic externalIds
    const prepared = validJobs.map(job => ({
      ...job,
      effectiveExternalId: job.externalId || createHash('sha1')
        .update(`${job.title ?? ''}:${job.company ?? ''}:${job.location ?? ''}`)
        .digest('hex')
        .slice(0, 16),
    }));

    // ── Bulk dedup: one query to find all already-existing (externalId, source) pairs ──
    const CHUNK = 500;
    for (let i = 0; i < prepared.length; i += CHUNK) {
      const chunk = prepared.slice(i, i + CHUNK);

      // Build a VALUES list for the dedup lookup
      const pairs = chunk.map(j => `(${sql.raw(`'${j.effectiveExternalId.replace(/'/g, "''")}'`)}, ${sql.raw(`'${(j.source ?? 'unknown').replace(/'/g, "''")}'`)})`);
      const existingRows = await db.execute(sql.raw(`
        SELECT external_id, source FROM job_postings
        WHERE (external_id, source) IN (${chunk.map(j =>
          `('${j.effectiveExternalId.replace(/'/g, "''")}', '${(j.source ?? 'unknown').replace(/'/g, "''")}')`
        ).join(', ')})
      `));
      const existingSet = new Set(
        (existingRows as any[]).map((r: any) => `${r.external_id}::${r.source}`)
      );

      // ── Cross-source URL dedup ──────────────────────────────────────────
      // The same posting arrives under different source labels with different
      // external_ids (sota-scraper emits bare `greenhouse`; scrape-all-company
      // emits `ATS:greenhouse`), so the (external_id, source) constraint can't
      // catch it and the feed shows the job twice. Skip inserting any job whose
      // real-post external_url already exists under ANY source. Safe because
      // every incoming URL passed isJobPostUrl (real post, not a homepage), so a
      // shared URL means the same posting — aggregator homepage URLs (which many
      // distinct jobs share) never reach here and can't be wrongly collapsed.
      const candidateUrls = [...new Set(
        chunk.map(j => j.externalUrl).filter((u): u is string => !!u)
      )];
      const existingUrlSet = new Set<string>();
      if (candidateUrls.length > 0) {
        const urlRows = await db.execute(sql.raw(`
          SELECT DISTINCT external_url FROM job_postings
          WHERE external_url IN (${candidateUrls.map(u => `'${u.replace(/'/g, "''")}'`).join(', ')})
        `));
        for (const r of (urlRows as any[])) existingUrlSet.add(r.external_url);
      }

      const existsByKey = (j: typeof chunk[number]) =>
        existingSet.has(`${j.effectiveExternalId}::${j.source ?? 'unknown'}`);

      const seenUrlsThisChunk = new Set<string>();
      const toInsert = chunk.filter(j => {
        if (existsByKey(j)) return false; // same (external_id, source) → handled as update
        const url = j.externalUrl;
        if (url) {
          // Already in DB under another source, or an earlier row in this batch.
          if (existingUrlSet.has(url) || seenUrlsThisChunk.has(url)) {
            stats.duplicates++;
            return false;
          }
          seenUrlsThisChunk.add(url);
        }
        return true;
      });
      const toUpdate = chunk.filter(existsByKey);

      // Bulk update liveness for existing jobs
      if (toUpdate.length > 0) {
        await db.execute(sql.raw(`
          UPDATE job_postings SET
            liveness_status = 'active',
            last_liveness_check = NOW(),
            updated_at = NOW()
          WHERE (external_id, source) IN (${toUpdate.map(j =>
            `('${j.effectiveExternalId.replace(/'/g, "''")}', '${(j.source ?? 'unknown').replace(/'/g, "''")}')`
          ).join(', ')})
        `));
        stats.duplicates += toUpdate.length;

        // Self-heal: backfill description/skills for existing rows that were
        // ingested as stubs (empty description/skills) before the lister carried
        // descriptions. Only fills when stored is empty and the incoming row now
        // has a description — never overwrites real data. One re-run heals the
        // historical ATS:* stub backlog without a separate script.
        const toBackfill = toUpdate
          .map(j => ({
            eid: j.effectiveExternalId,
            src: j.source ?? 'unknown',
            desc: (j.description ?? '').trim(),
            skills: normalizeSkills(j.skills?.length > 0 ? j.skills : extractSkillsFromText(j.description)),
          }))
          .filter(r => r.desc.length > 0);

        if (toBackfill.length > 0) {
          const values = toBackfill.map(r =>
            `('${r.eid.replace(/'/g, "''")}', '${r.src.replace(/'/g, "''")}', '${r.desc.replace(/'/g, "''")}', '${JSON.stringify(r.skills).replace(/'/g, "''")}')`
          ).join(', ');
          await db.execute(sql.raw(`
            UPDATE job_postings AS jp SET
              description = CASE WHEN jp.description IS NULL OR jp.description = '' THEN v.description ELSE jp.description END,
              skills = CASE WHEN jp.skills IS NULL OR jsonb_array_length(jp.skills) = 0 THEN v.skills::jsonb ELSE jp.skills END,
              updated_at = NOW()
            FROM (VALUES ${values}) AS v(external_id, source, description, skills)
            WHERE jp.external_id = v.external_id AND jp.source = v.source
          `));
        }
      }

      // Bulk insert new jobs using ON CONFLICT DO NOTHING as safety net
      if (toInsert.length > 0) {
        try {
          await db.insert(jobPostings).values(
            toInsert.map(job => ({
              talentOwnerId: systemUserId,
              title: job.title ?? 'Untitled Position',
              company: job.company ?? 'Unknown Company',
              location: job.location ?? null,
              description: job.description ?? 'No description provided',
              requirements: job.requirements ?? null,
              skills: normalizeSkills(
                job.skills?.length > 0 ? job.skills : extractSkillsFromText(job.description)
              ),
              // The upstream aggregators' workType is unreliable (loose
              // description scans, hardcoded 'hybrid' defaults). Re-derive it
              // from the canonical location signal so the feed filter is exact.
              workType: classifyWorkType({
                location: job.location,
                title: job.title,
                description: job.description,
              }),
              salaryMin: job.salaryMin ?? null,
              salaryMax: job.salaryMax ?? null,
              source: job.source ?? 'unknown',
              externalId: job.effectiveExternalId,
              externalUrl: job.externalUrl ?? null,
              careerPageUrl: job.careerPageUrl ?? null,
              trustScore: getSourceTrustScore(job.source),
              livenessStatus: 'unknown' as const,
              lastLivenessCheck: now,
              expiresAt,
              status: 'active' as const,
              createdAt: now,
              updatedAt: now,
            }))
          ).onConflictDoNothing();
          stats.inserted += toInsert.length;
        } catch (error) {
          console.error(`[JobIngestion] Bulk insert error for chunk ${i}–${i + CHUNK}:`, (error as Error).message);
          stats.errors += toInsert.length;
        }
      }
    }

    console.log(`[JobIngestion] Complete. Inserted: ${stats.inserted}, Duplicates: ${stats.duplicates}, Errors: ${stats.errors}, Skipped non-US: ${stats.skippedNonUS}, Skipped bad URL: ${stats.skippedBadUrl}`);
    return stats;
  }

  async expireStaleJobs(daysOld: number = 60): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await db
      .update(jobPostings)
      .set({
        status: 'closed',
        livenessStatus: 'stale'
      })
      .where(
        and(
          sql`${jobPostings.source} != 'platform'`,
          or(
            sql`${jobPostings.expiresAt} < NOW()`,
            sql`${jobPostings.createdAt} < ${cutoffDate.toISOString()}`
          ),
          eq(jobPostings.status, 'active')
        )
      );

    return result.count ?? 0;
  }

  // Resolve bad URLs for existing jobs (e.g., amazon.com → amazon.jobs)
  async resolveJobUrls(): Promise<{ resolved: number; errors: string[] }> {
    const errors: string[] = [];
    let resolved = 0;

    const { resolveAdzunaLink } = await import('../lib/adzuna-link-resolver');

    const BAD_URL_PATTERNS = ['amazon.com', 'microsoft.com', 'meta.com', 'google.com', 'apple.com'];
    const jobs = await db.execute(sql`
      SELECT id, title, company, location, description, external_url
      FROM job_postings
      WHERE status = 'active'
        AND external_url IS NOT NULL
        AND (
          LOWER(external_url) LIKE '%amazon.com%'
          OR LOWER(external_url) LIKE '%microsoft.com%'
          OR LOWER(external_url) LIKE '%meta.com%'
          OR LOWER(external_url) LIKE '%google.com%'
          OR LOWER(external_url) LIKE '%apple.com%'
        )
        AND created_at > NOW() - INTERVAL '90 days'
      LIMIT 500
    `);

    for (const job of jobs as any[]) {
      try {
        const result = await resolveAdzunaLink({
          title: job.title,
          company: job.company,
          location: job.location,
          fallbackUrl: job.external_url,
          description: job.description,
        });

        if (result.url && result.url !== job.external_url) {
          // Enforce the ingestion URL contract on resolved URLs too — the
          // resolver sometimes returns a careers landing instead of a real
          // job-post page (e.g. resolvedVia === 'careers_page'). Write only
          // the career_page_url in that case so the row is filtered from the
          // feed but still has a useful link for future re-resolution.
          const isRealPost = isJobPostUrl(result.url);
          const newSource = result.resolvedVia === 'ats' || result.resolvedVia === 'existing'
            ? result.atsType ?? 'career_page'
            : 'career_page';

          if (isRealPost) {
            await db.execute(sql`
              UPDATE job_postings
              SET external_url = ${result.url},
                  career_page_url = COALESCE(career_page_url, ${result.url}),
                  source = ${newSource},
                  trust_score = 70,
                  updated_at = NOW()
              WHERE id = ${job.id}
            `);
            resolved++;
          } else {
            // Don't overwrite external_url with a non-job-post URL; just stash it as career_page_url.
            await db.execute(sql`
              UPDATE job_postings
              SET career_page_url = COALESCE(career_page_url, ${result.url}),
                  updated_at = NOW()
              WHERE id = ${job.id}
            `);
          }
        }
      } catch (err) {
        errors.push(`${job.id}: ${(err as Error).message}`);
      }
    }

    console.log(`[resolveJobUrls] Resolved ${resolved}/${jobs.length} jobs`);
    return { resolved, errors };
  }
}

export const jobIngestionService = new JobIngestionService();