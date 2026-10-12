-- Feed gate (server/services/feed-gate.service.ts): a fixed set of scoring slots
-- shared by every instance. A slot is free when its lease has passed, so a slot
-- held by an instance that died frees itself. Additive and idempotent; without
-- this table the gate lets every request through, as before.
CREATE TABLE IF NOT EXISTS feed_gate_slots (
  slot         INT PRIMARY KEY,
  holder       TEXT,
  leased_until TIMESTAMPTZ NOT NULL DEFAULT 'epoch'
);
INSERT INTO feed_gate_slots (slot) SELECT g FROM generate_series(1, 50) g ON CONFLICT DO NOTHING;
