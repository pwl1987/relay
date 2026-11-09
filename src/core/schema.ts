// Relay P0-01A 持久状态层:Drizzle schema。
// 字段裁剪自 docs/DETAILED_ARCHITECTURE.md §2 候选表;裁决依据 ADR-0007(自研 PG 事务+租约+fencing)。
// 不变式:audit_events 仅插入(迁移后附加触发器阻断 UPDATE/DELETE);leases 行永不删除(fencing 单调依赖历史)。
import {
  bigint,
  bigserial,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  goalId: text("goal_id"),
  // 生命周期状态机取值见 src/core/lifecycle.ts(唯一权威)
  state: text("state").notNull().default("CREATED"),
  stateVersion: integer("state_version").notNull().default(0),
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  priority: integer("priority").notNull().default(0),
  // V02 最小作用域:允许写入的绝对路径前缀列表;空列表 = 默认拒绝(NFR-03)
  allowedScope: jsonb("allowed_scope").$type<string[]>().notNull().default([]),
  // V08 最小门锁:VERIFYING->ACCEPTED 需要存在 PASS 裁决
  gateRequired: boolean("gate_required").notNull().default(true),
  blockedReason: text("blocked_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const leases = pgTable("leases", {
  taskId: text("task_id")
    .primaryKey()
    .references(() => tasks.id),
  ownerId: text("owner_id").notNull(),
  fencingToken: bigint("fencing_token", { mode: "number" }).notNull(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditEvents = pgTable("audit_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  actor: text("actor").notNull(),
  // OWNER | SUPERVISOR | WORKER | RECONCILER | GATE(NFR-04 可解释)
  authority: text("authority").notNull().default("SUPERVISOR"),
  action: text("action").notNull(),
  taskId: text("task_id"),
  intentId: text("intent_id"),
  beforeState: text("before_state"),
  afterState: text("after_state"),
  detail: jsonb("detail").$type<Record<string, unknown>>(),
});

// 外部副作用两阶段日志(ADR 架构 §4;实验 exp-c 语义)
export const actionIntents = pgTable("action_intents", {
  id: text("id").primaryKey(),
  taskId: text("task_id").references(() => tasks.id),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  capability: text("capability").notNull(),
  target: text("target").notNull(),
  branch: text("branch"),
  expectedRemoteSha: text("expected_remote_sha"),
  payloadSha: text("payload_sha"),
  // RESERVED -> EXECUTING -> COMPLETED | CONFLICT | FAILED
  state: text("state").notNull().default("RESERVED"),
  reconcileRule: text("reconcile_rule").notNull().default("CHECK_THEN_DECIDE"),
  deadline: timestamp("deadline", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// V08 最小门锁:独立 Reviewer/Gate 的裁决记录;PASS 才允许 VERIFYING->ACCEPTED
export const taskGateVerdicts = pgTable("task_gate_verdicts", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  commitRef: text("commit_ref"),
  // PASS | REWORK | BLOCK
  verdict: text("verdict").notNull(),
  reviewer: text("reviewer").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Run 记录(P0-01B;架构 §2 裁剪:worker/event writer 写入)。
// Pi 是 RPC 子进程,不拥有工作流状态;run 行是 Relay 侧唯一权威事实。
// outcome: RUNNING | SUCCEEDED | FAILED | TIMEOUT | CANCELLED | INTERRUPTED(租约丢失中止)
// sandbox: docker | host-fallback(后者非安全边界,仅测试环境显式使用并如实记录)
export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  attempt: integer("attempt").notNull(),
  runtime: text("runtime").notNull().default("pi-rpc"),
  modelRef: text("model_ref").notNull(),
  inputCommitSha: text("input_commit_sha"),
  budget: jsonb("budget").$type<Record<string, unknown>>(),
  sandbox: text("sandbox").notNull(),
  outcome: text("outcome").notNull().default("RUNNING"),
  detail: jsonb("detail").$type<Record<string, unknown>>(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

// Session Context(P0-01B;架构 §2 裁剪:1 run : 1 session)。
// checkpoint_ref 在 --no-session 下恒空(不留 Pi 侧会话);恢复=重建上下文,
// resume_mode: fresh | context_rebuild(不假装恢复模型内部状态)。
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id),
  checkpointRef: text("checkpoint_ref"),
  handoffRef: jsonb("handoff_ref").$type<Record<string, unknown>>(),
  contextDigest: text("context_digest").notNull(),
  resumeMode: text("resume_mode").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
