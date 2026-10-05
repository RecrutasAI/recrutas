-- Lets a candidate stop the weekly summary email without turning off the
-- per-application alerts. Additive and idempotent.
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS weekly_summary BOOLEAN NOT NULL DEFAULT TRUE;
