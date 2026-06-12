-- Enable RLS on pipeline_runs (cron heartbeat table, added in PR #15 after the
-- 2026-06-05 RLS sweep, so it missed that migration).
--
-- Same rationale as 20260605000000_enable_rls_internal_tables.sql: the table
-- is only accessed by the Express server, which connects as the table owner
-- and is exempt from RLS. The browser client never reads it directly, so
-- enabling RLS with NO policy = deny-all to anon/authenticated via PostgREST.

ALTER TABLE public.pipeline_runs ENABLE ROW LEVEL SECURITY;
