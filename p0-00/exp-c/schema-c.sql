-- P0-00 实验 C:外部写动作意图表(实验代码)。与实验 B 共用 PG 实例,但不复用其表。
CREATE TABLE IF NOT EXISTS action_intents (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL,
  idempotency_key    TEXT UNIQUE NOT NULL,
  action             TEXT NOT NULL,
  remote_url         TEXT NOT NULL,
  branch             TEXT NOT NULL,
  expected_remote_sha TEXT NOT NULL,
  payload_sha        TEXT NOT NULL,
  state              TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
