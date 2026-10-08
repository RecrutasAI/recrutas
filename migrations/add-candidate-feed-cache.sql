-- Per-candidate cache of the ranked feed (server/services/feed-cache.service.ts).
-- One row per candidate + filter set. Additive and idempotent; dropping the
-- table only costs a re-score on each candidate's next visit.
CREATE TABLE IF NOT EXISTS candidate_feed_cache (
  candidate_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filter_key   TEXT NOT NULL,
  jobs         JSONB NOT NULL,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (candidate_id, filter_key)
);
CREATE INDEX IF NOT EXISTS candidate_feed_cache_computed_at_idx ON candidate_feed_cache (computed_at);
