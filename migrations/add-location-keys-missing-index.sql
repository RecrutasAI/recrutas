-- compute-location-keys looks for active jobs without location keys every hour. With almost none
-- missing, the planner walked the whole primary key (~190K pages, 1.5 GB) to find them, which
-- timed out (statement_timeout) whenever the 06:00/18:00 tech-company scrape was loading the disk
-- (failed 2026-10-12 06:35, 18:35 and 2026-10-13 18:35). This index holds only those rows.
-- Idempotent; CONCURRENTLY so ingestion keeps writing while it builds (run outside a transaction).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_postings_location_keys_missing
  ON job_postings (id) WHERE status = 'active' AND location_keys IS NULL;
