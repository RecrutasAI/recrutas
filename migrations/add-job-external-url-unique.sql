-- Make duplicate job rows structurally impossible, not just cleaned up after.
--
-- ingestExternalJobs guards duplicates by checking whether a URL already exists
-- and skipping it — but that is check-then-insert with no DB-level uniqueness,
-- and SEVEN call sites reach ingestExternalJobs (external-jobs-scheduler,
-- sota-scraper x3, job-refresh, scrape-external-jobs, scrape-all-company-jobs).
-- Two concurrent ingests can both pass the check and both insert. Measured
-- 2026-07-31: 744 duplicate rows had accumulated in ~32 days (~23/day), 742 of
-- them Adzuna, with byte-identical URLs — a race, not a matching bug.
--
-- Both insert paths already use ON CONFLICT DO NOTHING, so the loser of a race
-- is dropped silently rather than raising. Run this AFTER that code is deployed.
--
-- CONCURRENTLY: job_postings is written continuously by the scrapers and by the
-- embedding backfill, and a plain CREATE INDEX would block those writes for the
-- duration. CONCURRENTLY cannot run inside a transaction block — run this file
-- with psql -f, not wrapped in BEGIN/COMMIT.
--
-- Preconditions (verified before first run): zero duplicate external_url groups,
-- zero empty-string URLs. NULL is exempt automatically — NULLs never conflict in
-- a unique index, so platform jobs with no external URL are unaffected.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_job_external_url_unique
  ON job_postings (external_url);

-- The old non-unique index is now redundant: the unique index serves the same
-- equality lookups the dedup guard does. Dropping it also halves the write cost
-- on this column, which matters at ~12.8K new jobs/day.
DROP INDEX CONCURRENTLY IF EXISTS idx_job_external_url;
