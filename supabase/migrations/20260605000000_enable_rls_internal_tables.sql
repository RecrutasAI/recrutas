-- Enable RLS on internal/server-only tables that were exposed to the public
-- anon key via the Supabase REST API (confirmed readable: invite_codes,
-- error_events, request_metrics, match_signals, daily_usage_limits, etc.).
--
-- These tables are only ever accessed by the Express server, which connects
-- with the service_role / owner credentials and BYPASSES RLS. The browser
-- client never reads them directly (it uses Supabase for auth only — no
-- supabase.from() calls). So enabling RLS with NO policy = deny-all to
-- anon/authenticated, while leaving the server fully functional.

ALTER TABLE public.invite_codes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_code_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist_entries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.error_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_metrics         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_signals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scoring_weights         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_usage_limits      ENABLE ROW LEVEL SECURITY;
