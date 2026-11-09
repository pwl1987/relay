-- P0-00 实验 B:最小任务/租约/审计 schema(实验代码,非产品迁移)
-- 状态机: CREATED -> READY -> LEASED -> RUNNING -> ACCEPTED(最小化,仅用于验证租约语义)
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS leases;
DROP TABLE IF EXISTS tasks;

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  state         TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE leases (
  task_id         TEXT PRIMARY KEY REFERENCES tasks(id),
  owner_id        TEXT NOT NULL,
  fencing_token   BIGINT NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  heartbeat_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  seq          BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  task_id      TEXT,
  before_state TEXT,
  after_state  TEXT,
  detail       JSONB
);
