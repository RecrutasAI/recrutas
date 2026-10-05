-- Hard requirements read from each posting (server/lib/hard-requirements.ts),
-- kept in their own table so filling them never rewrites job_postings rows
-- (every non-HOT update there touches all its indexes, HNSW included).
-- Filled by scripts/compute-job-requirements.ts after each board sweep.
CREATE TABLE IF NOT EXISTS job_hard_requirements (
  job_id         INTEGER PRIMARY KEY REFERENCES job_postings(id) ON DELETE CASCADE,
  clearance      VARCHAR(16),          -- public_trust | secret | top_secret | ts_sci
  obtainable     BOOLEAN NOT NULL DEFAULT FALSE,
  us_citizen     BOOLEAN NOT NULL DEFAULT FALSE,
  us_person      BOOLEAN NOT NULL DEFAULT FALSE,
  no_sponsorship BOOLEAN NOT NULL DEFAULT FALSE,
  min_years      SMALLINT,
  computed_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
