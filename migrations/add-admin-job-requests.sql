-- Admin console actions (2026-10-09): "Run now" requests the VPS picks up every
-- minute, and snoozed signals. Additive only.

CREATE TABLE IF NOT EXISTS admin_job_requests (
  id            SERIAL PRIMARY KEY,
  job           TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  reason        TEXT NOT NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  result        TEXT
);
CREATE INDEX IF NOT EXISTS admin_job_requests_open_idx ON admin_job_requests (status, requested_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS admin_job_requests_job_idx ON admin_job_requests (job, requested_at DESC);

CREATE TABLE IF NOT EXISTS admin_signal_snoozes (
  key         TEXT PRIMARY KEY,
  until       TIMESTAMPTZ NOT NULL,
  snoozed_by  TEXT NOT NULL,
  reason      TEXT NOT NULL
);
