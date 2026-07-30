-- Track when a company was last probed for an ATS.
--
-- Without this, probePendingCompanies ordered pending companies by
-- (discovery_source_priority, id) with no recency term. Companies that came
-- back inconclusive (rate limited / provider circuit open) stayed `pending`
-- with an unchanged row, so the SAME companies sorted to the front of every
-- nightly run. The sweep only advanced by the handful that reached a verdict —
-- ~150 of 1,500 — leaving a 15k backlog draining in ~100 nights instead of ~10.
--
-- NULL means "never probed", which sorts first so brand-new discoveries are
-- still picked up promptly.

ALTER TABLE discovered_companies
  ADD COLUMN IF NOT EXISTS "lastProbedAt" timestamp;

-- Supports the probe's ordering: never-probed first, then least-recently-probed.
CREATE INDEX IF NOT EXISTS idx_discovered_pending_probe
  ON discovered_companies ("lastProbedAt" NULLS FIRST)
  WHERE status = 'pending';
