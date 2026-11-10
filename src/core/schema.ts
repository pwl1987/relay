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
  // P0-01C:relay_exec 命令前缀白名单;空列表 = 禁止一切命令执行(默认拒绝)
  allowedCommands: jsonb("allowed_commands").$type<string[]>().notNull().default([]),
  // V08 最小门锁:VERIFYING->ACCEPTED 需要存在 PASS 裁决
  gateRequired: boolean("gate_required").notNull().default(true),
  // P0-01C:退避——此前不参与 claimNextReady 候选(到期后自动回到候选池)
  retryNotBefore: timestamp("retry_not_before", { withTimezone: true }),
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

// V08 最小门锁 → P0-02A 绑定版 Gate:PASS 绑定 (attempt, candidate_sha, requirement_sha, test_env,
// reviewer_run_id, evidence_ids);消费一次性(consumed_at/consumed_by),旧 PASS 不跨 attempt/候选版本。
export const taskGateVerdicts = pgTable("task_gate_verdicts", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  commitRef: text("commit_ref"),
  // PASS | REWORK | BLOCK
  verdict: text("verdict").notNull(),
  reviewer: text("reviewer").notNull(),
  // ---- P0-02A 绑定列 ----
  attempt: integer("attempt"),
  candidateSha: text("candidate_sha"),
  requirementSha: text("requirement_sha"),
  testEnv: jsonb("test_env").$type<Record<string, unknown>>(),
  reviewerRunId: text("reviewer_run_id"),
  coderRunId: text("coder_run_id"),
  evidenceIds: jsonb("evidence_ids").$type<string[]>(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedBy: text("consumed_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// P0-02A C-1:Candidate ChangeSet(Worker 侧对 Run 工作区前后清单 diff;
// candidate_sha = 清单内容 sha256,requirement_sha = 需求快照 sha256)。
export const candidateChangesets = pgTable("candidate_changesets", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id),
  attempt: integer("attempt").notNull(),
  baseSha: text("base_sha").notNull(),
  candidateSha: text("candidate_sha").notNull(),
  requirementSha: text("requirement_sha").notNull(),
  // { added: string[], modified: string[], removed: string[] }
  changedFiles: jsonb("changed_files").$type<Record<string, string[]>>().notNull(),
  // 与 allowed_scope 的交集核验结果 { inScope: string[], violations: string[] }
  impactScope: jsonb("impact_scope").$type<Record<string, string[]>>().notNull(),
  // P0-02B D-1:三 SHA 区分 —— 清单 SHA(base_sha/candidate_sha)≠ Git Tree SHA ≠ Git Commit SHA。
  gitBaseCommitSha: text("git_base_commit_sha"),
  gitTreeSha: text("git_tree_sha"),
  gitCommitSha: text("git_commit_sha"),
  // P0-02B D-8:交付状态(NONE|PROPOSED|DELIVERING|DELIVERED|CONFLICT|FAILED);
  // DELIVERED 必须以远端核对(HEAD==payload 且树内容==候选清单)为前提。
  deliveryState: text("delivery_state").notNull().default("NONE"),
  deliveryIntentId: text("delivery_intent_id"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  deliveredRemoteHead: text("delivered_remote_head"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// P0-02B D-4:Action Proposal(交付授权基础 = 已消费 Gate PASS 裁决)。
// Policy 确定性裁决后 PROPOSED→POLICY_APPROVED|POLICY_DENIED;消费后 CONSUMED。
export const actionProposals = pgTable("action_proposals", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  attempt: integer("attempt").notNull(),
  changesetId: text("changeset_id")
    .notNull()
    .unique()
    .references(() => candidateChangesets.id),
  gateVerdictId: text("gate_verdict_id").notNull(),
  capability: text("capability").notNull(),
  target: text("target").notNull(),
  branch: text("branch").notNull(),
  expectedRemoteSha: text("expected_remote_sha").notNull(),
  commitSha: text("commit_sha").notNull(),
  // POLICY_APPROVED | POLICY_DENIED | CONSUMED
  state: text("state").notNull(),
  policyDetail: jsonb("policy_detail").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// P0-02A C-3:可信 Evidence(Worker 侧执行器采集:原始输出/时间/环境/内容摘要;
// passed 由 Worker 按退出码判定,非模型判定;绑定 (task, attempt, candidate_sha))。
export const gateEvidence = pgTable("gate_evidence", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  attempt: integer("attempt").notNull(),
  candidateSha: text("candidate_sha").notNull(),
  // deterministic_test | api_behavior | reviewer_output
  kind: text("kind").notNull(),
  passed: boolean("passed").notNull(),
  rawOutput: text("raw_output").notNull(),
  env: jsonb("env").$type<Record<string, unknown>>().notNull(),
  contentSha256: text("content_sha256").notNull(),
  producedBy: text("produced_by").notNull(),
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

// ---------- P0-01C:Goal Loop / Decision / Budget ----------

// Goal(架构 §2 裁剪;P0 单 Goal 单 WorkPackage,task.goal_id 直挂)。
// budget.modelCalls 为 Run 级模型调用上限来源;budget 缺 modelCalls ⇒ FAIL-CLOSED(不许模型 Run)。
// state: ACTIVE | PAUSED | EXHAUSTED | COMPLETED | FAILED
export const goals = pgTable("goals", {
  id: text("id").primaryKey(),
  rawInput: text("raw_input").notNull(),
  state: text("state").notNull().default("ACTIVE"),
  budget: jsonb("budget").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Decision(架构 §6:D0/D1 作用域内自动;D2 仅事先授权 fallback;D3 需人批准,
// **永不超时自动批准**(T07)——deadline 只标记 EXPIRED_STILL_BLOCKED,状态停留;
// D4 禁止)。state: OPEN | RESOLVED_AUTO | RESOLVED_FALLBACK | RESOLVED_MANUAL | REJECTED | EXPIRED_STILL_BLOCKED
export const decisions = pgTable("decisions", {
  id: text("id").primaryKey(),
  taskId: text("task_id").references(() => tasks.id),
  goalId: text("goal_id"),
  level: text("level").notNull(),
  question: text("question").notNull(),
  fallback: jsonb("fallback").$type<Record<string, unknown>>(),
  deadline: timestamp("deadline", { withTimezone: true }),
  state: text("state").notNull().default("OPEN"),
  verdict: jsonb("verdict").$type<Record<string, unknown>>(),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 预算账本(机器强制,先预留再执行后核算;FAIL-CLOSED:kind=model_calls 无账本行 ⇒ 拒绝)。
// kind: model_calls | tokens_in | tokens_out | wall_seconds;limit null = 仅记账不设限。
export const budgetLedger = pgTable("budget_ledger", {
  id: text("id").primaryKey(),
  scopeType: text("scope_type").notNull(), // goal | task | run
  scopeId: text("scope_id").notNull(),
  kind: text("kind").notNull(),
  limitValue: integer("limit_value"),
  reserved: integer("reserved").notNull().default(0),
  used: integer("used").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
