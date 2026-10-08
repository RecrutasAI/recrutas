-- Live switches (server/services/runtime-settings.service.ts) and the admin
-- audit log. Additive and idempotent. With the tables empty, every switch
-- uses its default, which is how the site behaves today.
CREATE TABLE IF NOT EXISTS runtime_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  pinned     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason     TEXT
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id     BIGSERIAL PRIMARY KEY,
  at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor  TEXT NOT NULL,          -- an admin's email, or 'autopilot'
  action TEXT NOT NULL,          -- e.g. setting.change, user.suspend
  target TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS admin_audit_log_at_idx ON admin_audit_log (at DESC);
