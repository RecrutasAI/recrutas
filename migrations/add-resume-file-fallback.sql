-- Resumes kept in our Postgres while Supabase Storage is unavailable
-- (server/lib/resume-files.ts). Keys start with 'db:'; scripts/move-fallback-resumes.ts
-- moves each file to Supabase once it answers and deletes the row. Additive and
-- idempotent; empty in normal operation.
CREATE TABLE IF NOT EXISTS resume_file_fallback (
  key          TEXT PRIMARY KEY,
  content      BYTEA NOT NULL,
  content_type TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
