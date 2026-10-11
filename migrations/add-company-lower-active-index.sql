-- Index on lower(company) for active jobs. The third-party list (server/storage.ts
-- getAggregatorFallbackJobs) selects "aggregator source OR reposter company"; with only the
-- source index the OR forced a sequential scan of every job (~0.4s per step of its relaxing
-- cascade, 6-9s per request). With this index Postgres ORs two index scans: ~50ms per step.
-- Applied in prod 2026-10-11 (1.3 MB). Built CONCURRENTLY to avoid locking writes; safe to re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_company_lower_active
ON job_postings (lower(company)) WHERE status = 'active';
