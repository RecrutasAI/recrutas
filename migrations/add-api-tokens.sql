-- Personal access tokens for the MCP connector (and later a public API).
-- Only a SHA-256 hash of each token is stored; the token itself is shown to
-- the user once at creation. Idempotent: safe to run more than once.
CREATE TABLE IF NOT EXISTS api_tokens (
  id            SERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          VARCHAR(80) NOT NULL,
  token_hash    CHAR(64) NOT NULL UNIQUE,
  token_prefix  VARCHAR(16) NOT NULL,
  last_used_at  TIMESTAMP,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens (user_id);
