-- Bias company discovery toward tech employers.
--
-- Context: `discover-companies` mines company names out of job_postings (i.e.
-- companies we already ingest) and the Wikipedia seed is disabled, so discovery
-- is a closed loop — it finds more of whatever the feed already skews toward.
-- Measured 2026-08-06: only ~20% of the live feed was tech, because ATS
-- discovery naturally surfaces high-turnover employers that post far more roles
-- than stable engineering orgs.
--
-- `techScore` (0-100 = share of a company's postings with a tech-role title)
-- becomes a tiebreaker in the probe queue, which is what actually decides which
-- companies get converted into directly-scraped ATS sources.
--
-- Ranking only. Nothing is ever filtered out by this column.

ALTER TABLE discovered_companies
  ADD COLUMN IF NOT EXISTS "techScore" integer DEFAULT 0;

-- Partial index: the probe queue only ever orders over pending rows.
CREATE INDEX IF NOT EXISTS idx_discovered_pending_tech
  ON discovered_companies ("techScore" DESC)
  WHERE status = 'pending';
