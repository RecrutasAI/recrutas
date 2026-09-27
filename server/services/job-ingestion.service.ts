/**
 * Job Ingestion Service
 * Persists external jobs to database with deduplication
 */

import { createHash } from 'crypto';
import { db } from '../db';
import { jobPostings, users } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { gt } from 'drizzle-orm/sql/expressions';
import { sql } from 'drizzle-orm/sql';
import { normalizeSkills, SKILL_ALIASES } from '../skill-normalizer';
import { classifyWorkType } from '../lib/work-type';
import { checkDbCapacity } from '../lib/db-capacity.js';
import {
  groupKey, groupSnapshots, planBoardExpiry, describeBoardExpiry, summarizeBoardReports,
  type BoardSnapshot, type ActiveJobRow, type BoardExpiryReport,
} from '../lib/snapshot-expiry';
import { isJobPostUrl } from '../lib/job-post-url';

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
    // Employer-owned ATS boards — the posting is the company's own.
    'greenhouse': 95,
    'lever': 95,
    'ashby': 95,
    'smartrecruiters': 95,
    'company-api': 95,
    'workday': 90,
    'workable': 90,
    'recruitee': 90,
    'breezy': 90,
    // Aggregators and job boards.
    'usajobs': 85,
    'remoteok': 75,
    'jsearch': 70,
    'themuse': 70,
    'arbeitnow': 65,
    'default': 50
  };
  // Ingestion stores ATS rows as "ATS:greenhouse" but the keys above are bare
  // vendor names, so every ATS row used to miss and take `default` (50). That
  // is what made the feed's trust badges invisible: "Verified Active" needs
  // >= 90, and 99.3% of live jobs were sitting at 50 — including 41.9K
  // Greenhouse and 19.7K Lever postings that should score 95.
  const key = source.toLowerCase().replace(/^ats:/, '');
  return trustScores[key] ?? trustScores.default;
}

// The job-post URL rule lives in server/lib/job-post-url.ts, shared with the
// feed's SQL filters. Re-exported here for existing importers.
export { isJobPostUrl };

/**
 * Unwrap the real Postgres cause from a Drizzle error.
 *
 * Drizzle's `message` is just "Failed query: insert into ..." with every bind
 * parameter inlined — for a 500-row chunk that is a ~250KB string with the
 * actual reason nowhere in it. Logging only `.message` is why 395 failed rows
 * per aggregator run sat undiagnosed: the logs recorded the SQL and dropped
 * the error. The driver puts the real detail on `.cause`.
 */
function describeDbError(error: unknown): string {
  const err = error as { cause?: { message?: string; code?: string; detail?: string }; message?: string };
  const cause = err?.cause;
  if (cause?.message || cause?.code) {
    const bits = [cause.code, cause.message, cause.detail].filter(Boolean);
    return bits.join(' | ').slice(0, 300);
  }
  return (err?.message ?? String(error)).slice(0, 200);
}

/**
 * Coerce an aggregator salary to the integer column salary_min/salary_max.
 *
 * Aggregators report hourly rates as decimals ("15.25"), which Postgres rejects
 * outright: `22P02 invalid input syntax for type integer`. Because inserts are
 * chunked and all-or-nothing, one such row used to fail its entire 500-row
 * chunk — this is the actual source of the ~395 lost jobs per aggregator run.
 * Rounding keeps the row; the cents are noise at this precision anyway.
 */
function toSalaryInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/** Build one job_postings row. Shared by the bulk path and the salvage path. */
function buildJobRow(job: any, systemUserId: string, now: Date, expiresAt: Date | null) {
  return {
    talentOwnerId: systemUserId,
    title: job.title ?? 'Untitled Position',
    company: job.company ?? 'Unknown Company',
    location: job.location ?? null,
    description: job.description ?? 'No description provided',
    requirements: job.requirements ?? null,
    skills: normalizeSkills(
      job.skills?.length > 0 ? job.skills : extractSkillsFromText(job.description)
    ),
    // The upstream aggregators' workType is unreliable (loose description
    // scans, hardcoded 'hybrid' defaults). Re-derive it from the canonical
    // location signal so the feed filter is exact.
    workType: classifyWorkType({
      location: job.location,
      title: job.title,
      description: job.description,
    }),
    salaryMin: toSalaryInt(job.salaryMin),
    salaryMax: toSalaryInt(job.salaryMax),
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
  };
}

export interface SnapshotExpiryStats {
  boardsUsable: number;
  skippedFailed: number;
  skippedIncomplete: number;
  skippedEmpty: number;
  skippedMassDrop: number;
  /** Rows closed — or, on a dry run, rows that would be. */
  closed: number;
  /** Missing rows left open because their board tripped a guard. */
  wouldCloseSkipped: number;
  /** Guard-skipped boards and the biggest closers, with sample URLs. */
  boards: { skipped: BoardExpiryReport[]; topClosing: BoardExpiryReport[] };
}

export class JobIngestionService {
  async ingestExternalJobs(jobs: ExternalJobInput[]): Promise<{ inserted: number; duplicates: number; errors: number; skippedNonUS: number; skippedBadUrl: number }> {
    const stats = { inserted: 0, duplicates: 0, errors: 0, skippedNonUS: 0, skippedBadUrl: 0 };
    console.log(`[JobIngestion] Processing ${jobs.length} external jobs...`);

    const capacity = await checkDbCapacity();
    if (capacity.blocked) {
      const mb = (n: number) => (n / (1024 * 1024)).toFixed(0);
      console.error(
        `[JobIngestion] BLOCKED: DB size ${mb(capacity.sizeBytes)}MB >= soft limit ${mb(capacity.limitBytes)}MB. ` +
        `Skipping ${jobs.length} jobs to avoid a hard provider quota. Free space (purge/upgrade) or raise DB_SOFT_LIMIT_BYTES.`
      );
      stats.errors = jobs.length;
      return stats;
    }

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

      // Bulk update liveness for existing jobs. Gated on staleness: scrapers
      // re-see every live job ~6x/day (ATS every 4h + tier runs), and an
      // unconditional touch rewrote all ~185K rows each pass — 1M+ updates and
      // ~5GB of WAL per day, which is what kept filling the VPS disk. A row
      // already marked active and checked in the last 20h carries no new
      // information, so skip it; the 20h window still guarantees a daily
      // touch, which is all liveness probing and expiry ever read.
      //
      // A re-seen row that is closed is reopened: its board lists it again, so
      // it is live, whatever closed it (snapshot expiry's 'removed' after a bad
      // read, or the unseen-cutoff's 'stale'). Only scraped rows reach this
      // path, and every closer of scraped rows keys on "not seen", so a sighting
      // always overrides it. Ghost-hiding closes platform jobs only.
      //
      // expires_at is pushed out once it is within 30 days, not on every
      // sighting: it is indexed, so changing it forces a non-HOT update through
      // all of job_postings' indexes (HNSW included). Extending at most monthly
      // keeps that to ~1/30 of re-seen rows a day.
      if (toUpdate.length > 0) {
        await db.execute(sql.raw(`
          UPDATE job_postings SET
            status = CASE WHEN status = 'closed' THEN 'active' ELSE status END,
            liveness_status = 'active',
            last_liveness_check = NOW(),
            expires_at = CASE
              WHEN expires_at IS NOT NULL AND expires_at < NOW() + INTERVAL '30 days'
              THEN NOW() + INTERVAL '60 days' ELSE expires_at END,
            updated_at = NOW()
          WHERE (external_id, source) IN (${toUpdate.map(j =>
            `('${j.effectiveExternalId.replace(/'/g, "''")}', '${(j.source ?? 'unknown').replace(/'/g, "''")}')`
          ).join(', ')})
            AND (status = 'closed'
              OR liveness_status IS DISTINCT FROM 'active'
              OR (expires_at IS NOT NULL AND expires_at < NOW() + INTERVAL '30 days')
              OR last_liveness_check IS NULL
              OR last_liveness_check < NOW() - INTERVAL '20 hours')
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
              -- Only touch rows that actually need healing: without this gate the
              -- CASEs keep the old values but updated_at = NOW() still rewrites
              -- every matched row on every scrape pass (WAL amplification).
              -- Empty skills only count when the incoming row has some: a
              -- posting no extractor finds skills in (common outside tech)
              -- would otherwise be rewritten on every pass, forever.
              AND (jp.description IS NULL OR jp.description = ''
                OR ((jp.skills IS NULL OR jsonb_array_length(jp.skills) = 0)
                  AND jsonb_array_length(v.skills::jsonb) > 0))
          `));
        }
      }

      // Bulk insert new jobs using ON CONFLICT DO NOTHING as safety net
      if (toInsert.length > 0) {
        try {
          // Count what the DB actually wrote, not what we offered it. With a
          // UNIQUE index on external_url, ON CONFLICT silently drops rows that
          // lost a race against a concurrent ingest, and assuming they all
          // landed would report inserts that never happened.
          const written = await db.insert(jobPostings).values(
            toInsert.map(job => buildJobRow(job, systemUserId, now, expiresAt))
          ).onConflictDoNothing().returning({ id: jobPostings.id });
          stats.inserted += written.length;
          stats.duplicates += toInsert.length - written.length;
        } catch (error) {
          // A chunk insert is all-or-nothing, so ONE bad row used to discard up
          // to 500 perfectly good jobs — measured at 395 lost per aggregator run
          // (~25% of that source). Fall back to per-row inserts so we lose only
          // the rows that are genuinely broken.
          console.error(
            `[JobIngestion] Bulk insert failed for chunk ${i}–${i + CHUNK} (${describeDbError(error)}) — ` +
            `retrying ${toInsert.length} rows individually`
          );
          const salvaged = await this.insertRowsIndividually(toInsert, systemUserId, now, expiresAt, stats);
          console.log(
            `[JobIngestion] Chunk ${i}–${i + CHUNK}: salvaged ${salvaged}/${toInsert.length} rows`
          );
        }
      }
    }

    console.log(`[JobIngestion] Complete. Inserted: ${stats.inserted}, Duplicates: ${stats.duplicates}, Errors: ${stats.errors}, Skipped non-US: ${stats.skippedNonUS}, Skipped bad URL: ${stats.skippedBadUrl}`);
    return stats;
  }

  /**
   * Salvage path for a failed bulk chunk: insert row by row so a single poison
   * row costs us that row instead of the other 499. Returns rows inserted, and
   * counts only the genuinely broken ones as errors — with the real reason, so
   * a recurring data problem is visible instead of silent.
   */
  private async insertRowsIndividually(
    rows: any[],
    systemUserId: string,
    now: Date,
    expiresAt: Date | null,
    stats: { inserted: number; errors: number; duplicates: number },
  ): Promise<number> {
    let inserted = 0;
    const reasons = new Map<string, number>();

    for (const job of rows) {
      try {
        const written = await db.insert(jobPostings)
          .values(buildJobRow(job, systemUserId, now, expiresAt))
          .onConflictDoNothing()
          .returning({ id: jobPostings.id });
        if (written.length > 0) {
          inserted++;
          stats.inserted++;
        } else {
          // Lost a uniqueness race — the row is already there, not an error.
          stats.duplicates++;
        }
      } catch (rowError) {
        const reason = describeDbError(rowError);
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
        stats.errors++;
      }
    }

    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      console.error(`[JobIngestion]   ${count} row(s) rejected: ${reason}`);
    }
    return inserted;
  }

  /**
   * Close jobs that are past their expiry or that no scraper has seen for
   * `daysUnseen` days.
   *
   * "Seen" is last_liveness_check, which ingestion refreshes whenever a scrape
   * lists the job again (created_at for a row never re-seen). This used to key
   * on created_at alone, which closed postings that were still live the day
   * they turned `daysOld`; purge-old-jobs then deleted them at 45 days and the
   * next scrape re-inserted them as new — a live posting was visible ~15 days
   * in every 45. A still-listed job now stays open, and a closed one reopens
   * on its next sighting.
   *
   * Batched deliberately. As a single statement this NEVER completed: db.ts sets
   * a 20s statement_timeout, and the update rewrites ~14KB-wide rows across all
   * 12 indexes on job_postings — `status` is indexed, so Postgres cannot take the
   * HOT-update path and every row re-inserts into every index, including the HNSW
   * vector index. It timed out on each run for weeks while reporting a cron
   * failure, leaving 37% of the live feed as postings that should have been
   * closed (2026-08-06).
   *
   * Each batch is its own transaction, so progress is kept even if a later batch
   * fails or the cron's wall-clock timeout fires — the next run resumes where this
   * one stopped, because closed rows no longer match the predicate.
   */
  async expireStaleJobs(
    daysUnseen: number = 60,
    opts: { batchSize?: number; maxMs?: number } = {}
  ): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysUnseen);

    const batchSize = opts.batchSize ?? 500;
    // Wall-clock budget so this can never be the reason a cron is killed. The
    // remainder is simply picked up by the next run.
    const maxMs = opts.maxMs ?? 10 * 60 * 1000;
    const startedAt = Date.now();

    let total = 0;
    for (;;) {
      if (Date.now() - startedAt > maxMs) {
        console.warn(
          `[JobIngestion] expireStaleJobs hit its ${maxMs}ms budget after ${total} rows — remainder deferred to the next run`
        );
        break;
      }

      // The LIMIT lives in a subquery: UPDATE itself takes no LIMIT, and this
      // lets each statement finish well inside the 20s statement_timeout.
      const result = await db
        .update(jobPostings)
        .set({
          status: 'closed',
          livenessStatus: 'stale'
        })
        .where(
          sql`${jobPostings.id} IN (
            SELECT id FROM job_postings
            WHERE source != 'platform'
              AND status = 'active'
              AND (expires_at < NOW()
                OR COALESCE(last_liveness_check, created_at) < ${cutoffDate.toISOString()})
            LIMIT ${batchSize}
          )`
        );

      const n = result.count ?? 0;
      total += n;
      if (n < batchSize) break; // drained
    }

    return total;
  }

  /**
   * Snapshot expiry (see server/lib/snapshot-expiry.ts): close active jobs that
   * a cleanly-read board no longer lists. Only rows created before the scrape
   * began are considered, so nothing this run inserted can be closed by it.
   *
   * dryRun reads and plans but writes nothing.
   */
  async expireMissingFromBoards(
    boards: BoardSnapshot[],
    runStartedAt: Date,
    opts: { dryRun?: boolean } = {},
  ): Promise<SnapshotExpiryStats> {
    const stats: SnapshotExpiryStats = {
      boardsUsable: 0, skippedFailed: 0, skippedIncomplete: 0, skippedEmpty: 0, skippedMassDrop: 0,
      closed: 0, wouldCloseSkipped: 0, boards: { skipped: [], topClosing: [] },
    };
    const reports: BoardExpiryReport[] = [];

    const groups = [...groupSnapshots(boards).values()];
    const usable = groups.filter(g => {
      if (g.usable) return true;
      if (g.reason === 'failed') stats.skippedFailed++;
      else stats.skippedIncomplete++;
      return false;
    });
    stats.boardsUsable = usable.length;

    const toClose: number[] = [];
    const CHUNK = 200;
    for (let i = 0; i < usable.length; i += CHUNK) {
      const chunk = usable.slice(i, i + CHUNK);
      const keys = sql.join(chunk.map(g => sql`(${g.source}, ${g.company})`), sql`, `);
      const rows = await db.execute(sql`
        SELECT id, source, company, external_url
        FROM job_postings
        WHERE (source, company) IN (${keys})
          AND status = 'active'
          AND created_at < ${runStartedAt.toISOString()}
      `) as any[];

      const byGroup = new Map<string, ActiveJobRow[]>();
      for (const r of rows) {
        const k = groupKey(r.source, r.company);
        let list = byGroup.get(k);
        if (!list) byGroup.set(k, list = []);
        list.push({ id: r.id, externalUrl: r.external_url });
      }

      for (const g of chunk) {
        const active = byGroup.get(groupKey(g.source, g.company)) ?? [];
        const plan = planBoardExpiry(active, g.seen);
        reports.push(describeBoardExpiry(g, active, plan));
        if (plan.action === 'close') {
          toClose.push(...plan.closeIds);
        } else {
          if (plan.reason === 'empty-board') stats.skippedEmpty++;
          else stats.skippedMassDrop++;
          stats.wouldCloseSkipped += plan.wouldClose;
        }
      }
    }
    stats.boards = summarizeBoardReports(reports);

    if (opts.dryRun) {
      stats.closed = toClose.length;
      return stats;
    }

    // 'removed', not 'stale': it marks these closures so ingestion can reopen a
    // job the board lists again without reviving anything another closer shut.
    for (let i = 0; i < toClose.length; i += 500) {
      const ids = sql.join(toClose.slice(i, i + 500).map(id => sql`${id}`), sql`, `);
      const result = await db.execute(sql`
        UPDATE job_postings
        SET status = 'closed', liveness_status = 'removed', updated_at = NOW()
        WHERE id IN (${ids}) AND status = 'active'
      `) as any;
      stats.closed += result.count ?? 0;
    }
    return stats;
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