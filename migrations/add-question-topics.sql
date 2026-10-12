-- Autofill (2026-10-12): which fact an application question asks, by its wording. Shared by
-- everyone and holding question text only, never anyone's answer: a wording the fixed rules
-- miss is classified once (by AI) and then known for every form. Additive only.

CREATE TABLE IF NOT EXISTS question_topics (
  label_norm  TEXT PRIMARY KEY,                -- the question, lowercased, punctuation removed
  fact        TEXT NOT NULL,                   -- a Fact (server/lib/autofill-truth.ts) or 'none'
  decided_by  TEXT NOT NULL CHECK (decided_by IN ('ai', 'rule')),
  seen        INTEGER NOT NULL DEFAULT 1,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
