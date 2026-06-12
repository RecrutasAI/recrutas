/**
 * Metrics API routes for the admin metrics dashboard.
 * All routes require x-admin-secret header.
 */

import { Express } from 'express';
import { db } from '../db.js';
import { requestMetrics, jobPostings, users, jobMatches, jobApplications } from '../../shared/schema.js';
import { sql } from 'drizzle-orm/sql';
import { getLimiterStats } from '../lib/groq-limiter.js';
import { redisEnabled } from '../lib/redis.js';
import { getModelInfo } from '../ml-matching.js';
import { verifyAdminSecret } from '../middleware/security.js';

export function registerMetricsRoutes(app: Express) {
  // ── Latency percentiles per endpoint (last N hours) ──────────────────────

  app.get('/api/admin/metrics/latency', async (req: any, res) => {
    if (!verifyAdminSecret(req, res)) return;
    if (!db) return res.status(503).json({ message: 'Database not available' });

    const hours = parseInt((req.query.hours as string) || '24', 10);
    const since = new Date(Date.now() - hours * 3600000);

    try {
      const rows = await db.execute(sql`
        SELECT
          endpoint,
          method,
          COUNT(*)::int                                          AS count,
          ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms))::int AS p50,
          ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS p95,
          ROUND(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms))::int AS p99,
          ROUND(AVG(duration_ms))::int                           AS avg_ms,
          SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END)::int AS errors,
          SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END)::int AS client_errors
        FROM request_metrics
        WHERE created_at >= ${since.toISOString()}
        GROUP BY endpoint, method
        ORDER BY count DESC
        LIMIT 50
      `);
      res.json({ hours, data: (rows as any).rows ?? rows });
    } catch (error: any) {
      res.status(500).json({ message: 'Failed to fetch latency metrics', error: error.message });
    }
  });

  // ── Error rate time series (last 24h by hour) ─────────────────────────────

  app.get('/api/admin/metrics/errors', async (req: any, res) => {
    if (!verifyAdminSecret(req, res)) return;
    if (!db) return res.status(503).json({ message: 'Database not available' });

    const hours = parseInt((req.query.hours as string) || '24', 10);
    const since = new Date(Date.now() - hours * 3600000);

    try {
      const rows = await db.execute(sql`
        SELECT
          date_trunc('hour', created_at) AS hour,
          COUNT(*)::int                  AS total,
          SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END)::int AS errors,
          SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END)::int AS client_errors,
          ROUND(
            100.0 * SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) /
            NULLIF(COUNT(*), 0), 2
          ) AS error_rate_pct
        FROM request_metrics
        WHERE created_at >= ${since.toISOString()}
        GROUP BY 1
        ORDER BY 1 ASC
      `);
      res.json({ hours, data: (rows as any).rows ?? rows });
    } catch (error: any) {
      res.status(500).json({ message: 'Failed to fetch error metrics', error: error.message });
    }
  });

  // ── Match quality distribution ────────────────────────────────────────────

  app.get('/api/admin/metrics/match-quality', async (req: any, res) => {
    if (!verifyAdminSecret(req, res)) return;
    if (!db) return res.status(503).json({ message: 'Database not available' });

    try {
      const rows = await db.execute(sql`
        SELECT
          CASE
            WHEN match_score >= 80 THEN 'excellent (80-100)'
            WHEN match_score >= 60 THEN 'good (60-79)'
            WHEN match_score >= 40 THEN 'fair (40-59)'
            ELSE 'poor (<40)'
          END AS bucket,
          COUNT(*)::int AS count,
          ROUND(AVG(match_score)::numeric, 1) AS avg_score
        FROM job_matches
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY 1
        ORDER BY 2 DESC
      `);

      const total = await db.execute(sql`
        SELECT
          COUNT(*)::int AS total,
          ROUND(AVG(match_score)::numeric, 1) AS avg_score,
          ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY match_score)::numeric, 1) AS median_score
        FROM job_matches
        WHERE created_at >= NOW() - INTERVAL '30 days'
      `);

      res.json({
        distribution: (rows as any).rows ?? rows,
        summary: ((total as any).rows ?? total)[0],
      });
    } catch (error: any) {
      res.status(500).json({ message: 'Failed to fetch match quality metrics', error: error.message });
    }
  });

  // ── Platform growth time series ───────────────────────────────────────────

  app.get('/api/admin/metrics/growth', async (req: any, res) => {
    if (!verifyAdminSecret(req, res)) return;
    if (!db) return res.status(503).json({ message: 'Database not available' });

    const days = parseInt((req.query.days as string) || '30', 10);

    try {
      const [newUsers, newJobs, newApplications] = await Promise.all([
        db.execute(sql`
          SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS count
          FROM users
          WHERE "createdAt" >= NOW() - (${days} || ' days')::interval
          GROUP BY 1 ORDER BY 1 ASC
        `),
        db.execute(sql`
          SELECT date_trunc('day', created_at) AS day, COUNT(*)::int AS count
          FROM job_postings
          WHERE created_at >= NOW() - (${days} || ' days')::interval
          GROUP BY 1 ORDER BY 1 ASC
        `),
        db.execute(sql`
          SELECT date_trunc('day', applied_at) AS day, COUNT(*)::int AS count
          FROM job_applications
          WHERE applied_at >= NOW() - (${days} || ' days')::interval
          GROUP BY 1 ORDER BY 1 ASC
        `),
      ]);

      res.json({
        days,
        users: (newUsers as any).rows ?? newUsers,
        jobs: (newJobs as any).rows ?? newJobs,
        applications: (newApplications as any).rows ?? newApplications,
      });
    } catch (error: any) {
      res.status(500).json({ message: 'Failed to fetch growth metrics', error: error.message });
    }
  });

  // ── HF API cache hit rate (embedding reuse) ───────────────────────────────

  app.get('/api/admin/metrics/embedding-cache', async (req: any, res) => {
    if (!verifyAdminSecret(req, res)) return;
    if (!db) return res.status(503).json({ message: 'Database not available' });

    try {
      const rows = await db.execute(sql`
        SELECT
          COUNT(*)::int                                                     AS total_active_jobs,
          SUM(CASE WHEN vector_embedding IS NOT NULL THEN 1 ELSE 0 END)::int AS with_embedding,
          SUM(CASE WHEN embedding_updated_at > NOW() - INTERVAL '7 days'
                    AND vector_embedding IS NOT NULL THEN 1 ELSE 0 END)::int AS fresh_embeddings,
          ROUND(
            100.0 * SUM(CASE WHEN vector_embedding IS NOT NULL THEN 1 ELSE 0 END) /
            NULLIF(COUNT(*), 0), 1
          ) AS coverage_pct
        FROM job_postings
        WHERE status = 'active'
      `);

      res.json(((rows as any).rows ?? rows)[0]);
    } catch (error: any) {
      res.status(500).json({ message: 'Failed to fetch embedding cache metrics', error: error.message });
    }
  });

  // ── Job feed health ───────────────────────────────────────────────────────

  app.get('/api/admin/metrics/job-feed', async (req: any, res) => {
    if (!verifyAdminSecret(req, res)) return;
    if (!db) return res.status(503).json({ message: 'Database not available' });

    try {
      const rows = await db.execute(sql`
        SELECT
          source,
          status,
          COUNT(*)::int AS count,
          ROUND(AVG(ghost_job_score), 1) AS avg_ghost_score,
          MIN(created_at) AS oldest_job,
          MAX(created_at) AS newest_job
        FROM job_postings
        GROUP BY source, status
        ORDER BY count DESC
        LIMIT 30
      `);

      const tableSize = await db.execute(sql`
        SELECT pg_size_pretty(pg_total_relation_size('job_postings')) AS table_size
      `);

      res.json({
        breakdown: (rows as any).rows ?? rows,
        tableSize: (((tableSize as any).rows ?? tableSize)[0] as any)?.table_size,
      });
    } catch (error: any) {
      res.status(500).json({ message: 'Failed to fetch job feed metrics', error: error.message });
    }
  });

  // ── Pitch / Investor overview ─────────────────────────────────────────────

  app.get('/api/admin/metrics/pitch', async (req: any, res) => {
    if (!verifyAdminSecret(req, res)) return;
    if (!db) return res.status(503).json({ message: 'Database not available' });

    try {
      const rows = await db.execute(sql`
        WITH 
        user_counts AS (
          SELECT 
            COUNT(*) FILTER (WHERE role = 'candidate') AS total_candidates,
            COUNT(*) FILTER (WHERE role = 'talent_owner') AS total_employers,
            COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '7 days') AS new_users_7d
          FROM users
        ),
        job_counts AS (
          SELECT 
            COUNT(*) FILTER (WHERE source = 'platform' AND status = 'active') AS internal_jobs,
            COUNT(*) FILTER (WHERE source != 'platform' AND status = 'active') AS external_jobs
          FROM job_postings
        ),
        match_counts AS (
          SELECT 
            COUNT(*) AS total_matches,
            COUNT(DISTINCT candidate_id) AS unique_candidates_matched
          FROM job_matches
        ),
        application_counts AS (
          SELECT 
            COUNT(*) AS total_applications,
            COUNT(DISTINCT candidate_id) AS unique_candidates_applied
          FROM job_applications
        ),
        chat_counts AS (
          SELECT COUNT(*) AS total_chats
          FROM chat_rooms
        ),
        profile_counts AS (
          SELECT 
            COUNT(*) FILTER (WHERE cu.resume_url IS NOT NULL) AS with_profile,
            COUNT(DISTINCT ea.candidate_id) FILTER (WHERE ea.status = 'completed') AS took_exam,
            COUNT(DISTINCT ea.candidate_id) FILTER (WHERE ea.passed_exam = true) AS passed_exam
          FROM candidate_users cu
          LEFT JOIN exam_attempts ea ON ea.candidate_id = cu.user_id
        ),
        sla_stats AS (
          SELECT
            COUNT(*) AS total_passed,
            SUM(CASE WHEN cr.access_granted_at IS NOT NULL AND cr.access_granted_at <= ea.response_deadline_at THEN 1 ELSE 0 END)::int AS sla_met,
            SUM(CASE WHEN cr.access_granted_at IS NULL AND ea.response_deadline_at > NOW() THEN 1 ELSE 0 END)::int AS pending,
            SUM(CASE WHEN cr.access_granted_at IS NULL AND ea.response_deadline_at <= NOW() THEN 1 ELSE 0 END)::int AS breached,
            ROUND(AVG(CASE WHEN cr.access_granted_at IS NOT NULL THEN EXTRACT(EPOCH FROM (cr.access_granted_at - ea.completed_at)) / 3600.0 END), 1) AS avg_response_hours
          FROM exam_attempts ea
          LEFT JOIN chat_rooms cr ON cr.candidate_id = ea.candidate_id AND cr.job_id = ea.job_id
          WHERE ea.passed_exam = true AND ea.completed_at IS NOT NULL AND ea.response_deadline_at IS NOT NULL
        ),
        exam_stats AS (
          SELECT
            COUNT(*) AS total_attempts,
            SUM(CASE WHEN passed_exam = true THEN 1 ELSE 0 END)::int AS passed,
            ROUND(AVG(CASE WHEN status = 'completed' THEN score END), 1) AS avg_score
          FROM exam_attempts
        ),
        feed_stats AS (
          SELECT
            COUNT(DISTINCT source)::int AS source_count,
            COUNT(DISTINCT company)::int AS companies_count,
            COUNT(*)::int AS total_active,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS added_24h,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS added_7d
          FROM job_postings
          WHERE status = 'active' AND source != 'platform'
        )
        SELECT 
          uc.total_candidates,
          uc.total_employers,
          jc.internal_jobs,
          jc.external_jobs,
          mc.total_matches,
          ac.total_applications,
          cc.total_chats,
          uc.new_users_7d,
          pc.with_profile,
          mc.unique_candidates_matched AS got_match,
          ac.unique_candidates_applied AS applied,
          pc.took_exam,
          pc.passed_exam,
          cc.total_chats AS got_chat,
          ss.total_passed,
          ss.sla_met,
          ss.pending,
          ss.breached,
          ROUND(100.0 * ss.sla_met / NULLIF(ss.total_passed, 0), 1) AS compliance_pct,
          ss.avg_response_hours,
          es.total_attempts,
          es.passed,
          ROUND(100.0 * es.passed / NULLIF(es.total_attempts, 0), 1) AS pass_rate_pct,
          es.avg_score,
          fs.source_count,
          fs.companies_count,
          fs.total_active,
          fs.added_24h,
          fs.added_7d
        FROM user_counts uc, job_counts jc, match_counts mc, application_counts ac, chat_counts cc, profile_counts pc, sla_stats ss, exam_stats es, feed_stats fs
      `);

      const data = ((rows as any).rows ?? rows)[0];
      res.json({
        kpis: {
          total_candidates: data.total_candidates,
          total_employers: data.total_employers,
          internal_jobs: data.internal_jobs,
          external_jobs: data.external_jobs,
          total_matches: data.total_matches,
          total_applications: data.total_applications,
          total_chats: data.total_chats,
          new_users_7d: data.new_users_7d,
        },
        funnel: {
          with_profile: data.with_profile,
          got_match: data.got_match,
          applied: data.applied,
          took_exam: data.took_exam,
          passed_exam: data.passed_exam,
          got_chat: data.got_chat,
        },
        sla: {
          total_passed: data.total_passed,
          sla_met: data.sla_met,
          pending: data.pending,
          breached: data.breached,
          compliance_pct: data.compliance_pct,
          avg_response_hours: data.avg_response_hours,
        },
        exam: {
          total_attempts: data.total_attempts,
          passed: data.passed,
          pass_rate_pct: data.pass_rate_pct,
          avg_score: data.avg_score,
        },
        feed: {
          source_count: data.source_count,
          companies_count: data.companies_count,
          total_active: data.total_active,
          added_24h: data.added_24h,
          added_7d: data.added_7d,
        },
      });
    } catch (error: any) {
      res.status(500).json({ message: 'Failed to fetch pitch metrics', error: error.message });
    }
  });

  // ── System health snapshot ────────────────────────────────────────────────

  app.get('/api/admin/metrics/system', async (req: any, res) => {
    if (!verifyAdminSecret(req, res)) return;

    res.json({
      groqLimiter: getLimiterStats(),
      redis: { enabled: redisEnabled },
      mlModel: getModelInfo(),
      inngest: { enabled: !!process.env.INNGEST_EVENT_KEY },
      sentry: { enabled: !!process.env.SENTRY_DSN },
      posthog: {
        ingestEnabled: !!process.env.POSTHOG_KEY,
        readEnabled: !!process.env.POSTHOG_PERSONAL_API_KEY && !!process.env.POSTHOG_PROJECT_ID,
      },
      environment: process.env.NODE_ENV,
      vercel: !!process.env.VERCEL,
      uptime: process.uptime(),
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
  });

  // ── PostHog funnel snapshot (last N days) ─────────────────────────────────
  // Queries the core candidate funnel via PostHog HogQL and returns step counts
  // + conversion rates. Used by the weekly numbers ritual.

  app.get('/api/admin/metrics/posthog-funnel', async (req: any, res) => {
    if (!verifyAdminSecret(req, res)) return;

    const token = process.env.POSTHOG_PERSONAL_API_KEY;
    const projectId = process.env.POSTHOG_PROJECT_ID;
    const host = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
    if (!token || !projectId) {
      return res.status(503).json({ message: 'PostHog read access not configured' });
    }

    const days = Math.max(1, Math.min(90, parseInt((req.query.days as string) || '7', 10)));
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const steps: Array<{ event: string; label: string }> = [
      { event: '$identify', label: 'signed_in' },
      { event: 'resume_uploaded', label: 'resume_uploaded' },
      { event: 'application_created', label: 'application_created' },
      { event: 'exam_graded', label: 'exam_graded' },
      { event: 'sla_response_sent', label: 'sla_response_sent' },
    ];

    try {
      const results = await Promise.all(
        steps.map(async ({ event, label }) => {
          const query = {
            query: {
              kind: 'HogQLQuery',
              query: `SELECT count(DISTINCT distinct_id) AS users, count() AS total FROM events WHERE event = '${event}' AND timestamp >= toDateTime('${since}')`,
            },
          };
          const r = await fetch(`${host.replace(/\/$/, '')}/api/projects/${projectId}/query/`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(query),
          });
          if (!r.ok) {
            return { event, label, users: 0, total: 0, error: `HTTP ${r.status}` };
          }
          const data: any = await r.json();
          const row = data?.results?.[0] ?? [0, 0];
          return { event, label, users: Number(row[0] ?? 0), total: Number(row[1] ?? 0) };
        })
      );

      const topUsers = results[0]?.users || 0;
      const withConversion = results.map((r, i) => ({
        ...r,
        conversion_pct: topUsers > 0 ? Math.round((r.users / topUsers) * 1000) / 10 : null,
        step_conversion_pct:
          i === 0
            ? 100
            : results[i - 1].users > 0
              ? Math.round((r.users / results[i - 1].users) * 1000) / 10
              : null,
      }));

      res.json({ days, since, steps: withConversion });
    } catch (error: any) {
      res.status(500).json({ message: 'Failed to fetch PostHog funnel', error: error.message });
    }
  });

  // ── Weekly numbers — Supabase + PostHog snapshot ──────────────────────────
  // Powers the admin dashboard "Weekly" tab. Same shape as scripts/weekly-numbers.ts.

  app.get('/api/admin/metrics/weekly-numbers', async (req: any, res) => {
    if (!verifyAdminSecret(req, res)) return;
    if (!db) return res.status(503).json({ message: 'Database not available' });

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000);

    const growth = (curr: number, prior: number) =>
      prior > 0 ? `${Math.round(((curr - prior) / prior) * 100)}%` : curr > 0 ? '∞' : '0%';

    try {
      const [userRows, appRows, examRows, jobRows, slaRows]: any[] = await Promise.all([
        db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE "createdAt" >= ${weekAgo.toISOString()})::int AS users_this_week,
            COUNT(*) FILTER (WHERE "createdAt" >= ${twoWeeksAgo.toISOString()} AND "createdAt" < ${weekAgo.toISOString()})::int AS users_prior_week,
            COUNT(*)::int AS users_total,
            COUNT(*) FILTER (WHERE role = 'candidate')::int AS candidates_total,
            COUNT(*) FILTER (WHERE role = 'talent_owner')::int AS talent_owners_total
          FROM users
        `),
        db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE created_at >= ${weekAgo.toISOString()})::int AS apps_this_week,
            COUNT(*) FILTER (WHERE created_at >= ${twoWeeksAgo.toISOString()} AND created_at < ${weekAgo.toISOString()})::int AS apps_prior_week,
            COUNT(*)::int AS apps_total
          FROM job_applications
        `),
        db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE created_at >= ${weekAgo.toISOString()})::int AS attempts_this_week,
            COUNT(*) FILTER (WHERE created_at >= ${weekAgo.toISOString()} AND passed_exam = true)::int AS passes_this_week,
            COUNT(*)::int AS attempts_total
          FROM exam_attempts
        `),
        db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE created_at >= ${weekAgo.toISOString()})::int AS jobs_added_this_week,
            COUNT(*)::int AS jobs_total,
            COUNT(DISTINCT company)::int AS companies_total
          FROM job_postings
          WHERE status = 'active'
        `),
        db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE created_at >= ${weekAgo.toISOString()} AND status IN ('interview','offer','hired'))::int AS positive_responses,
            COUNT(*) FILTER (WHERE created_at >= ${weekAgo.toISOString()} AND status = 'rejected')::int AS rejections
          FROM job_applications
        `),
      ]);

      const u = (userRows.rows ?? userRows)[0] || {};
      const a = (appRows.rows ?? appRows)[0] || {};
      const e = (examRows.rows ?? examRows)[0] || {};
      const j = (jobRows.rows ?? jobRows)[0] || {};
      const s = (slaRows.rows ?? slaRows)[0] || {};

      const supabase = {
        users: {
          total: u.users_total ?? 0,
          candidates: u.candidates_total ?? 0,
          talent_owners: u.talent_owners_total ?? 0,
          this_week: u.users_this_week ?? 0,
          prior_week: u.users_prior_week ?? 0,
          wow_growth: growth(u.users_this_week ?? 0, u.users_prior_week ?? 0),
        },
        applications: {
          total: a.apps_total ?? 0,
          this_week: a.apps_this_week ?? 0,
          prior_week: a.apps_prior_week ?? 0,
          wow_growth: growth(a.apps_this_week ?? 0, a.apps_prior_week ?? 0),
        },
        exams: {
          total_attempts: e.attempts_total ?? 0,
          attempts_this_week: e.attempts_this_week ?? 0,
          passes_this_week: e.passes_this_week ?? 0,
          pass_rate_this_week:
            (e.attempts_this_week ?? 0) > 0
              ? `${Math.round(((e.passes_this_week ?? 0) / e.attempts_this_week) * 100)}%`
              : '—',
        },
        jobs: {
          active_total: j.jobs_total ?? 0,
          added_this_week: j.jobs_added_this_week ?? 0,
          companies_total: j.companies_total ?? 0,
        },
        responses: {
          positive_this_week: s.positive_responses ?? 0,
          rejections_this_week: s.rejections ?? 0,
        },
      };

      let funnel: any[] | null = null;
      const token = process.env.POSTHOG_PERSONAL_API_KEY;
      const projectId = process.env.POSTHOG_PROJECT_ID;
      const host = (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/$/, '');
      if (token && projectId) {
        const steps = [
          { event: '$identify', label: 'signed_in' },
          { event: 'resume_uploaded', label: 'resume_uploaded' },
          { event: 'application_created', label: 'application_created' },
          { event: 'exam_graded', label: 'exam_graded' },
          { event: 'sla_response_sent', label: 'sla_response_sent' },
        ];
        funnel = await Promise.all(
          steps.map(async ({ event, label }) => {
            try {
              const r = await fetch(`${host}/api/projects/${projectId}/query/`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  query: {
                    kind: 'HogQLQuery',
                    query: `SELECT count(DISTINCT distinct_id), count() FROM events WHERE event = '${event}' AND timestamp >= toDateTime('${weekAgo.toISOString()}')`,
                  },
                }),
              });
              if (!r.ok) return { label, users: 0, total: 0 };
              const data: any = await r.json();
              const row = data?.results?.[0] ?? [0, 0];
              return { label, users: Number(row[0] ?? 0), total: Number(row[1] ?? 0) };
            } catch {
              return { label, users: 0, total: 0 };
            }
          })
        );
      }

      res.json({
        generatedAt: now.toISOString(),
        weekOf: weekAgo.toISOString().slice(0, 10),
        supabase,
        funnel,
      });
    } catch (error: any) {
      res.status(500).json({ message: 'Failed to fetch weekly numbers', error: error.message });
    }
  });
}
