// 只读视图(P0-02C D-4)。
// 铁律:本文件**只含 SELECT**。它把 PostgreSQL(唯一业务事实源)里的行聚合成页面/接口
// 需要的形状;**不产生状态、不写库、不复制第二套状态机**。
// 任何状态转移都必须回到 src/core/*(D-3)。
// 可用动作(availableActions)由 core 的转移表(TRANSITIONS/isLegalTransition)裁决 ——
// 界面不能提供 core 会拒绝的转移。
import { sql } from "drizzle-orm";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { RelayDb } from "../core/db.ts";
import { TRANSITIONS, isLegalTransition, type TaskState } from "../core/lifecycle.ts";
import { ledgerSnapshot } from "../core/budget.ts";

/** Server 进程启动时刻(System 页 uptime 基准)。 */
const serverStartedAt = new Date().toISOString();

type Row = Record<string, unknown>;

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function num(v: unknown): number {
  return Number(v ?? 0);
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "object") return v as T;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}

// ---------------- Dashboard ----------------

export interface TaskStateCounts {
  [state: string]: number;
}

export interface DashboardView {
  generatedAt: string;
  goals: Array<{
    id: string;
    rawInput: string;
    state: string;
    createdAt: string;
    updatedAt: string;
    taskCounts: TaskStateCounts;
    taskTotal: number;
  }>;
  taskCounts: TaskStateCounts;
  taskTotal: number;
  blocked: Array<{
    taskId: string;
    goalId: string | null;
    state: string;
    stateVersion: number;
    blockedReason: string | null;
    attempt: number;
    maxAttempts: number;
    openDecision: { id: string; level: string; question: string; deadline: string | null } | null;
  }>;
  openDecisionCount: number;
  expiredStillBlockedCount: number;
  runs: {
    total: number;
    byOutcome: Record<string, number>;
    recent: Array<{ id: string; taskId: string; outcome: string; sandbox: string; startedAt: string; endedAt: string | null; reason: string | null }>;
  };
  budget: Array<{ scopeType: string; scopeId: string; kind: string; limit: number | null; reserved: number; used: number }>;
  budgetTotals: { limit: number | null; reserved: number; used: number; kind: string };
  audit: Array<{ seq: number; ts: string; actor: string; authority: string; action: string; taskId: string | null; beforeState: string | null; afterState: string | null }>;
  anomalies: Array<{ kind: string; subject: string; detail: string; ts: string | null }>;
  lastProgressAt: string | null;
}

export async function dashboardView(db: RelayDb): Promise<DashboardView> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };

  const goalRows = await exec.execute(sql`
    SELECT id, raw_input, state, created_at, updated_at FROM goals ORDER BY created_at DESC LIMIT 100
  `);
  const taskCountRows = await exec.execute(sql`
    SELECT goal_id, state, count(*)::int AS n FROM tasks GROUP BY goal_id, state
  `);
  const allTaskRows = await exec.execute(sql`
    SELECT state, count(*)::int AS n FROM tasks GROUP BY state
  `);
  const blockedRows = await exec.execute(sql`
    SELECT id, goal_id, state, state_version, blocked_reason, attempt, max_attempts, updated_at
    FROM tasks
    WHERE state IN ('NEEDS_DECISION','BLOCKED','NEEDS_RECONCILE','REWORK','FAILED','PAUSED')
    ORDER BY updated_at DESC LIMIT 50
  `);
  const openDecRows = await exec.execute(sql`
    SELECT d.id, d.task_id, d.level, d.question, d.deadline, d.state
    FROM decisions d JOIN tasks t ON t.id = d.task_id
    WHERE d.state IN ('OPEN','EXPIRED_STILL_BLOCKED')
    ORDER BY d.created_at LIMIT 100
  `);
  const runRows = await exec.execute(sql`
    SELECT id, task_id, outcome, sandbox, started_at, ended_at, detail->>'reason' AS reason
    FROM runs ORDER BY started_at DESC LIMIT 40
  `);
  const runTotal = await exec.execute(sql`SELECT count(*)::int AS n FROM runs`);
  const ledgerRows = await exec.execute(sql`
    SELECT scope_type, scope_id, kind, limit_value, reserved, used FROM budget_ledger
    ORDER BY scope_type, scope_id, kind
  `);
  const auditRows = await exec.execute(sql`
    SELECT seq, ts, actor, authority, action, task_id, before_state, after_state
    FROM audit_events ORDER BY seq DESC LIMIT 40
  `);
  const lastProgress = await exec.execute(sql`
    SELECT max(ts) AS ts FROM audit_events
  `);
  const deliveryBad = await exec.execute(sql`
    SELECT id, task_id, delivery_state FROM candidate_changesets
    WHERE delivery_state IN ('CONFLICT','FAILED','DELIVERING')
  `);
  const gateBad = await exec.execute(sql`
    SELECT id, task_id, verdict FROM task_gate_verdicts WHERE verdict IN ('BLOCK','REWORK') AND consumed_at IS NULL
  `);

  // 聚合
  const countsByGoal = new Map<string, TaskStateCounts>();
  for (const r of taskCountRows.rows) {
    const gid = str(r["goal_id"]);
    const bucket = countsByGoal.get(gid) ?? {};
    bucket[str(r["state"])] = num(r["n"]);
    countsByGoal.set(gid, bucket);
  }
  const taskCounts: TaskStateCounts = {};
  for (const r of allTaskRows.rows) taskCounts[str(r["state"])] = num(r["n"]);
  const taskTotal = Object.values(taskCounts).reduce((a, b) => a + b, 0);

  const openDecisionByTask = new Map<string, Row>();
  let openDecisionCount = 0;
  let expiredStillBlockedCount = 0;
  for (const r of openDecRows.rows) {
    openDecisionCount += 1;
    if (str(r["state"]) === "EXPIRED_STILL_BLOCKED") expiredStillBlockedCount += 1;
    const tid = str(r["task_id"]);
    if (tid && !openDecisionByTask.has(tid)) openDecisionByTask.set(tid, r);
  }

  const goals = goalRows.rows.map((r) => {
    const id = str(r["id"]);
    const counts = countsByGoal.get(id) ?? {};
    return {
      id,
      rawInput: str(r["raw_input"]),
      state: str(r["state"]),
      createdAt: iso(r["created_at"]) ?? "",
      updatedAt: iso(r["updated_at"]) ?? "",
      taskCounts: counts,
      taskTotal: Object.values(counts).reduce((a, b) => a + b, 0),
    };
  });

  const blocked = blockedRows.rows.map((r) => {
    const tid = str(r["id"]);
    const d = openDecisionByTask.get(tid);
    return {
      taskId: tid,
      goalId: r["goal_id"] === null ? null : str(r["goal_id"]),
      state: str(r["state"]),
      stateVersion: num(r["state_version"]),
      blockedReason: r["blocked_reason"] === null ? null : str(r["blocked_reason"]),
      attempt: num(r["attempt"]),
      maxAttempts: num(r["max_attempts"]),
      openDecision: d
        ? { id: str(d["id"]), level: str(d["level"]), question: str(d["question"]), deadline: iso(d["deadline"]) }
        : null,
    };
  });

  const byOutcome: Record<string, number> = {};
  for (const r of runRows.rows) {
    const o = str(r["outcome"]);
    byOutcome[o] = (byOutcome[o] ?? 0) + 1;
  }

  const budget = ledgerRows.rows.map((r) => ({
    scopeType: str(r["scope_type"]),
    scopeId: str(r["scope_id"]),
    kind: str(r["kind"]),
    limit: r["limit_value"] === null ? null : num(r["limit_value"]),
    reserved: num(r["reserved"]),
    used: num(r["used"]),
  }));
  const modelCalls = budget.filter((b) => b.kind === "model_calls");
  const budgetTotals = {
    kind: "model_calls",
    limit: modelCalls.length ? modelCalls.reduce((a, b) => a + (b.limit ?? 0), 0) : null,
    reserved: modelCalls.reduce((a, b) => a + b.reserved, 0),
    used: modelCalls.reduce((a, b) => a + b.used, 0),
  };

  const anomalies: DashboardView["anomalies"] = [];
  for (const r of blockedRows.rows) {
    if (!["FAILED", "BLOCKED", "NEEDS_RECONCILE"].includes(str(r["state"]))) continue;
    anomalies.push({
      kind: `task_${str(r["state"]).toLowerCase()}`,
      subject: str(r["id"]),
      detail: str(r["blocked_reason"]) || `任务处于 ${str(r["state"])}`,
      ts: iso(r["updated_at"]),
    });
  }
  for (const r of runRows.rows) {
    const o = str(r["outcome"]);
    if (!["FAILED", "TIMEOUT", "INTERRUPTED", "CANCELLED"].includes(o)) continue;
    anomalies.push({
      kind: `run_${o.toLowerCase()}`,
      subject: str(r["id"]),
      detail: str(r["reason"]) || `运行结果 ${o}`,
      ts: iso(r["started_at"]),
    });
  }
  for (const r of deliveryBad.rows) {
    anomalies.push({
      kind: `delivery_${str(r["delivery_state"]).toLowerCase()}`,
      subject: str(r["id"]),
      detail: `变更集 ${str(r["id"])} 交付状态 ${str(r["delivery_state"])}`,
      ts: null,
    });
  }
  for (const r of gateBad.rows) {
    anomalies.push({
      kind: `gate_${str(r["verdict"]).toLowerCase()}`,
      subject: str(r["id"]),
      detail: `Gate 裁决 ${str(r["verdict"])} 未消费(任务 ${str(r["task_id"])})`,
      ts: null,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    goals,
    taskCounts,
    taskTotal,
    blocked,
    openDecisionCount,
    expiredStillBlockedCount,
    runs: {
      total: num(runTotal.rows[0]?.["n"]),
      byOutcome,
      recent: runRows.rows.map((r) => ({
        id: str(r["id"]),
        taskId: str(r["task_id"]),
        outcome: str(r["outcome"]),
        sandbox: str(r["sandbox"]),
        startedAt: iso(r["started_at"]) ?? "",
        endedAt: iso(r["ended_at"]),
        reason: r["reason"] === null ? null : str(r["reason"]),
      })),
    },
    budget,
    budgetTotals,
    audit: auditRows.rows.map((r) => ({
      seq: num(r["seq"]),
      ts: iso(r["ts"]) ?? "",
      actor: str(r["actor"]),
      authority: str(r["authority"]),
      action: str(r["action"]),
      taskId: r["task_id"] === null ? null : str(r["task_id"]),
      beforeState: r["before_state"] === null ? null : str(r["before_state"]),
      afterState: r["after_state"] === null ? null : str(r["after_state"]),
    })),
    anomalies: anomalies.slice(0, 40),
    lastProgressAt: iso(lastProgress.rows[0]?.["ts"]),
  };
}

// ---------------- Goal 列表 / 详情 ----------------

export interface GoalSummary {
  id: string;
  rawInput: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  taskTotal: number;
  taskCounts: TaskStateCounts;
}

export async function goalListView(db: RelayDb): Promise<GoalSummary[]> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };
  const g = await exec.execute(sql`
    SELECT id, raw_input, state, created_at, updated_at FROM goals ORDER BY created_at DESC LIMIT 200
  `);
  const c = await exec.execute(sql`SELECT goal_id, state, count(*)::int AS n FROM tasks GROUP BY goal_id, state`);
  const byGoal = new Map<string, TaskStateCounts>();
  for (const r of c.rows) {
    const gid = str(r["goal_id"]);
    const b = byGoal.get(gid) ?? {};
    b[str(r["state"])] = num(r["n"]);
    byGoal.set(gid, b);
  }
  return g.rows.map((r) => {
    const counts = byGoal.get(str(r["id"])) ?? {};
    return {
      id: str(r["id"]),
      rawInput: str(r["raw_input"]),
      state: str(r["state"]),
      createdAt: iso(r["created_at"]) ?? "",
      updatedAt: iso(r["updated_at"]) ?? "",
      taskTotal: Object.values(counts).reduce((a, b) => a + b, 0),
      taskCounts: counts,
    };
  });
}

export interface TaskView {
  id: string;
  goalId: string | null;
  state: string;
  stateVersion: number;
  attempt: number;
  maxAttempts: number;
  priority: number;
  gateRequired: boolean;
  allowedScope: string[];
  allowedCommands: string[];
  blockedReason: string | null;
  retryNotBefore: string | null;
  createdAt: string;
  updatedAt: string;
  openDecision: { id: string; level: string; question: string; state: string; deadline: string | null } | null;
  availableActions: Array<{ id: string; label: string; toState: string }>;
}

export interface EvidenceView {
  id: string;
  kind: string;
  passed: boolean;
  attempt: number;
  candidateSha: string;
  contentSha256: string;
  producedBy: string;
  createdAt: string;
  rawOutput: string;
  env: Record<string, unknown>;
}

export interface GateVerdictView {
  id: string;
  verdict: string;
  reviewer: string;
  attempt: number | null;
  candidateSha: string | null;
  requirementSha: string | null;
  reviewerRunId: string | null;
  coderRunId: string | null;
  evidenceIds: string[];
  testEnv: Record<string, unknown>;
  consumedAt: string | null;
  consumedBy: string | null;
  createdAt: string;
  /** 证据是否来自当前候选(SHA 不匹配 ⇒ 需重验) */
  staleEvidence: boolean;
}

export interface ChangesetSummary {
  id: string;
  taskId: string;
  runId: string;
  attempt: number;
  baseSha: string;
  candidateSha: string;
  requirementSha: string;
  gitBaseCommitSha: string | null;
  gitTreeSha: string | null;
  gitCommitSha: string | null;
  changedFiles: { added: string[]; modified: string[]; removed: string[] };
  impactScope: { inScope: string[]; violations: string[] };
  deliveryState: string;
  deliveredRemoteHead: string | null;
  createdAt: string;
}

export interface RunView {
  id: string;
  taskId: string;
  attempt: number;
  outcome: string;
  sandbox: string;
  modelRef: string;
  role: string | null;
  startedAt: string;
  endedAt: string | null;
  reason: string | null;
  detail: Record<string, unknown>;
}

export interface DecisionView {
  id: string;
  taskId: string | null;
  goalId: string | null;
  level: string;
  question: string;
  fallback: Record<string, unknown> | null;
  deadline: string | null;
  state: string;
  verdict: Record<string, unknown> | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  taskState: string | null;
  taskStateVersion: number | null;
  /** 超时后的默认行为(D3 恒为"永不自动批准") */
  timeoutBehavior: string;
  affectedFiles: string[];
  reversible: boolean;
  canApprove: boolean;
  canReject: boolean;
  canDefer: boolean;
  /** OPERATOR-CONSOLE-00 P0-UI-4:决策支持五要素(为何需人工/推荐/备选/风险/不处理影响) */
  guidance: {
    why: string;
    recommended: string | null;
    alternatives: string[];
    risk: string | null;
    impactOfNoAction: string;
  };
}

export interface GoalDetail {
  goal: {
    id: string;
    rawInput: string;
    state: string;
    budget: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
  };
  tasks: TaskView[];
  runs: RunView[];
  changesets: ChangesetSummary[];
  evidence: EvidenceView[];
  gates: GateVerdictView[];
  decisions: DecisionView[];
  audit: Array<{ seq: number; ts: string; actor: string; authority: string; action: string; taskId: string | null; beforeState: string | null; afterState: string | null; detail: Record<string, unknown> }>;
  budget: Array<{ kind: string; limit: number | null; reserved: number; used: number }>;
  analysis: GoalAnalysis;
  /** REWORK-1:最新 Discovery 记录与来源徽章(model=模型分析;rules=规则面兜底,不冒充模型) */
  discovery: GoalDiscoveryView;
  /** OPERATOR-CONSOLE-00 P0-UI-3:确定性执行进度(阶段/当前模型/耗时/计数) */
  progress: GoalProgress;
}

export interface GoalDiscoveryView {
  source: "model" | "rules";
  note: string;
  /** 最新记录(SUCCEEDED 含 report;FAILED 含 reason —— 失败如实,不伪造) */
  latest?: {
    id: string;
    runId: string;
    outcome: "SUCCEEDED" | "FAILED";
    reason: string | null;
    report: Record<string, unknown> | null;
    contentSha256: string | null;
    modelRef: string;
    sandbox: string;
    createdAt: string;
  };
}

export interface GoalAnalysis {
  /** 分析来源标注 —— 恒为 deterministic(非模型) */
  source: "deterministic";
  sourceLabel: string;
  understanding: {
    rawInput: string;
    derivedTasks: Array<{ taskId: string; allowedScope: string[]; allowedCommands: string[]; gateRequired: boolean }>;
    acceptanceBasis: string;
    constraints: Record<string, unknown>;
  };
  /** 模型驱动分析:未实现 —— 显式标记,页面不得伪造 */
  modelAnalysis: { status: "NOT_IMPLEMENTED"; note: string };
  suggestions: Array<{ id: string; subject: string; text: string; basis: string; verifiableBy: string }>;
}

const TIMEOUT_BEHAVIOR: Record<string, string> = {
  D0: "作用域内自动执行(不产生决策行)",
  D1: "作用域内自动执行(不产生决策行)",
  D2: "仅按创建时已声明的 fallback 自动执行",
  D3: "永不超时自动批准:超时仅标记 EXPIRED_STILL_BLOCKED,任务停留 NEEDS_DECISION 等待人",
  D4: "禁止(创建即拒绝)",
};

/** P0-UI-4:决策支持五要素(全部由既有列确定性推导;不伪造系统未有的判断)。 */
function decisionGuidance(input: {
  level: string;
  question: string;
  fallback: Record<string, unknown> | null;
  taskState: string | null;
  blockedReason: string | null;
  deadline: string | null;
  reversible: boolean;
}): DecisionView["guidance"] {
  const levelWhy: Record<string, string> = {
    D2: "D2 级决策:仅当创建时已声明 fallback 才可由循环自动执行;当前行等待人工裁决或按已授权 fallback 处理。",
    D3: "D3 级决策:涉及需人工批准的事项(Gate 消费 BLOCK、Review 有界失败或外部副作用),**永不超时自动批准**。",
    D4: "D4 级:系统禁止此类决策(创建即拒绝)。",
  };
  const why =
    (levelWhy[input.level] ?? "级别 " + input.level + " 需人工裁决。") +
    (input.taskState ? " 任务当前 " + input.taskState + ",在裁决前不推进。" : "") +
    (input.blockedReason ? " 阻塞原因:" + input.blockedReason : "");
  const fb = input.fallback ?? {};
  const recommendedRaw = fb["recommended"] ?? fb["action"] ?? null;
  const recommended =
    typeof recommendedRaw === "string" && recommendedRaw.trim()
      ? recommendedRaw
      : recommendedRaw && typeof recommendedRaw === "object"
        ? JSON.stringify(recommendedRaw)
        : null;
  const alternatives = Array.isArray(fb["alternatives"])
    ? (fb["alternatives"] as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  const riskRaw = fb["risk"] ?? null;
  const risk =
    typeof riskRaw === "string" && riskRaw.trim()
      ? riskRaw
      : input.reversible
        ? "未登记专用风险说明;该决策关联的操作按架构要求可回滚(交付绑定远端 SHA,本地 bare/真实远端均可核对)。"
        : "未登记专用风险说明;请结合问题与受影响文件评估。";
  const impactOfNoAction =
    (input.deadline ? "期限 " + input.deadline + ";逾期 " : "无期限;") +
    (input.level === "D3"
      ? "仅标记 EXPIRED_STILL_BLOCKED,任务停留等待,**不会自动批准**;其他安全任务不受影响继续推进。"
      : "按超时语义处理(见超时行为)。");
  return {
    why,
    recommended,
    alternatives,
    risk,
    impactOfNoAction,
  };
}

function availableActionsFor(task: TaskView, hasOpenDecision: boolean): TaskView["availableActions"] {
  const actions: TaskView["availableActions"] = [];
  const can = (to: string): boolean => isLegalTransition(task.state, to);
  if (task.state === "NEEDS_DECISION" && hasOpenDecision) {
    if (can("READY")) actions.push({ id: "decision_approve", label: "批准决策(任务→READY)", toState: "READY" });
    if (can("FAILED")) actions.push({ id: "decision_reject", label: "拒绝决策(任务→FAILED)", toState: "FAILED" });
  }
  if (["BLOCKED", "PAUSED", "NEEDS_RECONCILE"].includes(task.state)) {
    if (can("READY")) actions.push({ id: "resume", label: "恢复任务(→READY)", toState: "READY" });
  }
  return actions;
}

export async function goalDetailView(db: RelayDb, goalId: string): Promise<GoalDetail | null> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };
  const g = await exec.execute(sql`SELECT id, raw_input, state, budget, created_at, updated_at FROM goals WHERE id = ${goalId}`);
  const grow = g.rows[0];
  if (!grow) return null;

  const t = await exec.execute(sql`
    SELECT id, goal_id, state, state_version, attempt, max_attempts, priority, gate_required,
           allowed_scope, allowed_commands, blocked_reason, retry_not_before, created_at, updated_at
    FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at
  `);

  const dec = await exec.execute(sql`
    SELECT id, task_id, goal_id, level, question, fallback, deadline, state, verdict, decided_by, decided_at, created_at
    FROM decisions WHERE goal_id = ${goalId} OR task_id IN (SELECT id FROM tasks WHERE goal_id = ${goalId}) ORDER BY created_at
  `);
  const openDecisionByTask = new Map<string, Row>();
  for (const r of dec.rows) {
    if (str(r["state"]) !== "OPEN" && str(r["state"]) !== "EXPIRED_STILL_BLOCKED") continue;
    const tid = str(r["task_id"]);
    if (tid) openDecisionByTask.set(tid, r);
  }

  const tasks: TaskView[] = t.rows.map((r) => {
    const tid = str(r["id"]);
    const d = openDecisionByTask.get(tid);
    const base: TaskView = {
      id: tid,
      goalId: r["goal_id"] === null ? null : str(r["goal_id"]),
      state: str(r["state"]),
      stateVersion: num(r["state_version"]),
      attempt: num(r["attempt"]),
      maxAttempts: num(r["max_attempts"]),
      priority: num(r["priority"]),
      gateRequired: r["gate_required"] === true,
      allowedScope: json<string[]>(r["allowed_scope"], []),
      allowedCommands: json<string[]>(r["allowed_commands"], []),
      blockedReason: r["blocked_reason"] === null ? null : str(r["blocked_reason"]),
      retryNotBefore: iso(r["retry_not_before"]),
      createdAt: iso(r["created_at"]) ?? "",
      updatedAt: iso(r["updated_at"]) ?? "",
      openDecision: d
        ? { id: str(d["id"]), level: str(d["level"]), question: str(d["question"]), state: str(d["state"]), deadline: iso(d["deadline"]) }
        : null,
      availableActions: [],
    };
    base.availableActions = availableActionsFor(base, Boolean(d));
    return base;
  });

  const runRows = await exec.execute(sql`
    SELECT id, task_id, attempt, outcome, sandbox, model_ref, detail, started_at, ended_at
    FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE goal_id = ${goalId}) ORDER BY started_at DESC LIMIT 100
  `);
  const runs: RunView[] = runRows.rows.map((r) => {
    const detail = json<Record<string, unknown>>(r["detail"], {});
    return {
      id: str(r["id"]),
      taskId: str(r["task_id"]),
      attempt: num(r["attempt"]),
      outcome: str(r["outcome"]),
      sandbox: str(r["sandbox"]),
      modelRef: str(r["model_ref"]),
      role: detail["role"] === undefined ? null : str(detail["role"]),
      startedAt: iso(r["started_at"]) ?? "",
      endedAt: iso(r["ended_at"]),
      reason: detail["reason"] === undefined ? null : str(detail["reason"]),
      detail,
    };
  });

  const csRows = await exec.execute(sql`
    SELECT id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope,
           git_base_commit_sha, git_tree_sha, git_commit_sha, delivery_state, delivered_remote_head, created_at
    FROM candidate_changesets WHERE task_id IN (SELECT id FROM tasks WHERE goal_id = ${goalId}) ORDER BY created_at DESC
  `);
  const changesets: ChangesetSummary[] = csRows.rows.map((r) => ({
    id: str(r["id"]),
    taskId: str(r["task_id"]),
    runId: str(r["run_id"]),
    attempt: num(r["attempt"]),
    baseSha: str(r["base_sha"]),
    candidateSha: str(r["candidate_sha"]),
    requirementSha: str(r["requirement_sha"]),
    gitBaseCommitSha: r["git_base_commit_sha"] === null ? null : str(r["git_base_commit_sha"]),
    gitTreeSha: r["git_tree_sha"] === null ? null : str(r["git_tree_sha"]),
    gitCommitSha: r["git_commit_sha"] === null ? null : str(r["git_commit_sha"]),
    changedFiles: json<ChangesetSummary["changedFiles"]>(r["changed_files"], { added: [], modified: [], removed: [] }),
    impactScope: json<ChangesetSummary["impactScope"]>(r["impact_scope"], { inScope: [], violations: [] }),
    deliveryState: str(r["delivery_state"]),
    deliveredRemoteHead: r["delivered_remote_head"] === null ? null : str(r["delivered_remote_head"]),
    createdAt: iso(r["created_at"]) ?? "",
  }));

  const evRows = await exec.execute(sql`
    SELECT id, task_id, attempt, candidate_sha, kind, passed, raw_output, env, content_sha256, produced_by, created_at
    FROM gate_evidence WHERE task_id IN (SELECT id FROM tasks WHERE goal_id = ${goalId}) ORDER BY created_at DESC LIMIT 200
  `);
  const evidence: EvidenceView[] = evRows.rows.map((r) => ({
    id: str(r["id"]),
    kind: str(r["kind"]),
    passed: r["passed"] === true,
    attempt: num(r["attempt"]),
    candidateSha: str(r["candidate_sha"]),
    contentSha256: str(r["content_sha256"]),
    producedBy: str(r["produced_by"]),
    createdAt: iso(r["created_at"]) ?? "",
    rawOutput: str(r["raw_output"]).slice(0, 8000),
    env: json<Record<string, unknown>>(r["env"], {}),
  }));

  const gateRows = await exec.execute(sql`
    SELECT id, task_id, verdict, reviewer, attempt, candidate_sha, requirement_sha,
           reviewer_run_id, coder_run_id, evidence_ids, test_env, consumed_at, consumed_by, created_at
    FROM task_gate_verdicts WHERE task_id IN (SELECT id FROM tasks WHERE goal_id = ${goalId}) ORDER BY created_at DESC
  `);
  const currentCandidateByTask = new Map(changesets.map((c) => [c.taskId, c.candidateSha]));
  const gates: GateVerdictView[] = gateRows.rows.map((r) => {
    const taskId = str(r["task_id"]);
    const cur = currentCandidateByTask.get(taskId) ?? "";
    const cand = r["candidate_sha"] === null ? null : str(r["candidate_sha"]);
    return {
      id: str(r["id"]),
      verdict: str(r["verdict"]),
      reviewer: str(r["reviewer"]),
      attempt: r["attempt"] === null ? null : num(r["attempt"]),
      candidateSha: cand,
      requirementSha: r["requirement_sha"] === null ? null : str(r["requirement_sha"]),
      reviewerRunId: r["reviewer_run_id"] === null ? null : str(r["reviewer_run_id"]),
      coderRunId: r["coder_run_id"] === null ? null : str(r["coder_run_id"]),
      evidenceIds: json<string[]>(r["evidence_ids"], []),
      testEnv: json<Record<string, unknown>>(r["test_env"], {}),
      consumedAt: iso(r["consumed_at"]),
      consumedBy: r["consumed_by"] === null ? null : str(r["consumed_by"]),
      createdAt: iso(r["created_at"]) ?? "",
      staleEvidence: cur !== "" && cand !== null && cand !== cur,
    };
  });

  const decisions: DecisionView[] = dec.rows.map((r) => {
    const level = str(r["level"]);
    const state = str(r["state"]);
    const pending = state === "OPEN" || state === "EXPIRED_STILL_BLOCKED";
    const tRow = t.rows.find((x) => str(x["id"]) === str(r["task_id"]));
    const cs = changesets.find((c) => c.taskId === str(r["task_id"]));
    const affected = cs ? [...cs.changedFiles.added, ...cs.changedFiles.modified, ...cs.changedFiles.removed] : [];
    const taskState = tRow ? str(tRow["state"]) : null;
    const legal = taskState ? isLegalTransition(taskState, "READY") : false;
    return {
      id: str(r["id"]),
      taskId: r["task_id"] === null ? null : str(r["task_id"]),
      goalId: r["goal_id"] === null ? null : str(r["goal_id"]),
      level,
      question: str(r["question"]),
      fallback: json<Record<string, unknown> | null>(r["fallback"], null),
      deadline: iso(r["deadline"]),
      state,
      verdict: json<Record<string, unknown> | null>(r["verdict"], null),
      decidedBy: r["decided_by"] === null ? null : str(r["decided_by"]),
      decidedAt: iso(r["decided_at"]),
      createdAt: iso(r["created_at"]) ?? "",
      taskState,
      taskStateVersion: tRow ? num(tRow["state_version"]) : null,
      timeoutBehavior: TIMEOUT_BEHAVIOR[level] ?? "未登记",
      affectedFiles: affected,
      reversible: level === "D3",
      canApprove: pending && level !== "D4" && legal,
      canReject: pending && level !== "D4",
      canDefer: pending && level !== "D4",
      guidance: decisionGuidance({
        level,
        question: str(r["question"]),
        fallback: json<Record<string, unknown> | null>(r["fallback"], null),
        taskState,
        blockedReason: tRow && tRow["blocked_reason"] !== null && tRow["blocked_reason"] !== undefined ? str(tRow["blocked_reason"]) : null,
        deadline: iso(r["deadline"]),
        reversible: level === "D3",
      }),
    };
  });

  const auditRows = await exec.execute(sql`
    SELECT seq, ts, actor, authority, action, task_id, before_state, after_state, detail
    FROM audit_events WHERE task_id IN (SELECT id FROM tasks WHERE goal_id = ${goalId}) ORDER BY seq DESC LIMIT 100
  `);

  const ledger = await ledgerSnapshot(db, "goal", goalId);

  const analysis = buildGoalAnalysis(
    { rawInput: str(grow["raw_input"]), budget: json<Record<string, unknown> | null>(grow["budget"], null) },
    tasks,
    decisions,
    changesets,
    ledger,
  );

  const discRows = await exec.execute(sql`
    SELECT id, run_id, outcome, reason, report, content_sha256, model_ref, sandbox, created_at
    FROM discoveries WHERE goal_id = ${goalId} ORDER BY created_at DESC LIMIT 1
  `);
  const discRow = discRows.rows[0];
  let discovery: GoalDiscoveryView;
  if (discRow && str(discRow["outcome"]) === "SUCCEEDED") {
    discovery = {
      source: "model",
      note: "来源=模型(结构化分析持久化;可经 discoveries+runs 回放)",
      latest: {
        id: str(discRow["id"]),
        runId: str(discRow["run_id"]),
        outcome: "SUCCEEDED",
        reason: null,
        report: json<Record<string, unknown> | null>(discRow["report"], null),
        contentSha256: discRow["content_sha256"] === null ? null : str(discRow["content_sha256"]),
        modelRef: str(discRow["model_ref"]),
        sandbox: str(discRow["sandbox"]),
        createdAt: iso(discRow["created_at"]) ?? "",
      },
    };
  } else if (discRow && str(discRow["outcome"]) === "FAILED") {
    discovery = {
      source: "rules",
      note: `模型分析失败(已如实落记:${str(discRow["reason"])});以下为规则推导,非模型结论`,
      latest: {
        id: str(discRow["id"]),
        runId: str(discRow["run_id"]),
        outcome: "FAILED",
        reason: discRow["reason"] === null ? null : str(discRow["reason"]),
        report: null,
        contentSha256: null,
        modelRef: str(discRow["model_ref"]),
        sandbox: str(discRow["sandbox"]),
        createdAt: iso(discRow["created_at"]) ?? "",
      },
    };
  } else {
    discovery = { source: "rules", note: "尚未运行模型分析;以下为规则推导,非模型结论" };
  }

  return {
    goal: {
      id: str(grow["id"]),
      rawInput: str(grow["raw_input"]),
      state: str(grow["state"]),
      budget: json<Record<string, unknown> | null>(grow["budget"], null),
      createdAt: iso(grow["created_at"]) ?? "",
      updatedAt: iso(grow["updated_at"]) ?? "",
    },
    tasks,
    runs,
    changesets,
    evidence,
    gates,
    decisions,
    audit: auditRows.rows.map((r) => ({
      seq: num(r["seq"]),
      ts: iso(r["ts"]) ?? "",
      actor: str(r["actor"]),
      authority: str(r["authority"]),
      action: str(r["action"]),
      taskId: r["task_id"] === null ? null : str(r["task_id"]),
      beforeState: r["before_state"] === null ? null : str(r["before_state"]),
      afterState: r["after_state"] === null ? null : str(r["after_state"]),
      detail: json<Record<string, unknown>>(r["detail"], {}),
    })),
    budget: ledger,
    analysis,
    discovery,
    progress: buildGoalProgress({
      goalState: str(grow["state"]),
      tasks: tasks.map((x) => ({ id: x.id, state: x.state })),
      runs: runs.map((x) => ({ outcome: x.outcome, modelRef: x.modelRef, startedAt: x.startedAt })),
      changesets: changesets.map((x) => ({ deliveryState: x.deliveryState, deliveredAt: null })),
      openDecisions: decisions.filter((d) => d.state === "OPEN" || d.state === "EXPIRED_STILL_BLOCKED").length,
      evidenceCount: evidence.length,
      gateCount: gates.length,
    }),
  };
}

/**
 * 确定性分析(P0-02C D-5 / 反例 10):**规则推导**,不是模型分析。
 * 每条建议都带 basis(依据的 DB 事实)与 verifiableBy(如何验证),禁止无据结论。
 */
export function buildGoalAnalysis(
  goal: { rawInput: string; budget: Record<string, unknown> | null },
  tasks: TaskView[],
  decisions: DecisionView[],
  changesets: ChangesetSummary[],
  ledger: Array<{ kind: string; limit: number | null; reserved: number; used: number }>,
): GoalAnalysis {
  const suggestions: GoalAnalysis["suggestions"] = [];
  const modelCalls = ledger.find((l) => l.kind === "model_calls");

  for (const t of tasks) {
    if (t.openDecision) {
      suggestions.push({
        id: `decision:${t.openDecision.id}`,
        subject: t.id,
        text: `等待决策 ${t.openDecision.id}(${t.openDecision.level})人工裁决:D3 永不超时自动批准,任务保持 NEEDS_DECISION。`,
        basis: `decisions.id=${t.openDecision.id};tasks.state=${t.state}`,
        verifiableBy: "Decision Inbox 中该决策仍为 OPEN/EXPIRED_STILL_BLOCKED 且 tasks.state 仍为 NEEDS_DECISION",
      });
      continue;
    }
    switch (t.state) {
      case "BLOCKED":
        suggestions.push({
          id: `blocked:${t.id}`,
          subject: t.id,
          text: `任务被阻塞:${t.blockedReason ?? "未记录原因"}。恢复需 operator 授权(状态版本校验)。`,
          basis: `tasks.state=BLOCKED;blocked_reason=${t.blockedReason ?? "-"}`,
          verifiableBy: "批准恢复后 tasks.state 变为 READY 且 audit 出现 TASK_RESUMED",
        });
        break;
      case "NEEDS_RECONCILE":
        suggestions.push({
          id: `reconcile:${t.id}`,
          subject: t.id,
          text: "外部副作用结果不确定:必须先核对真实状态(Reconcile),不得盲目重试。",
          basis: "tasks.state=NEEDS_RECONCILE",
          verifiableBy: "audit 出现 RECONCILE_* 且 tasks.state 离开 NEEDS_RECONCILE",
        });
        break;
      case "FAILED":
        suggestions.push({
          id: `failed:${t.id}`,
          subject: t.id,
          text: `任务失败(尝试 ${t.attempt}/${t.maxAttempts}):失败原因与证据见运行记录。`,
          basis: `tasks.state=FAILED;attempt=${t.attempt}`,
          verifiableBy: "runs.outcome 与 runs.detail.reason 给出失败原因",
        });
        break;
      case "READY":
        suggestions.push({
          id: `ready:${t.id}`,
          subject: t.id,
          text: "可被 Worker 领取执行;执行后需经 Gate(独立 Review + 真实测试)才能算通过。",
          basis: `tasks.state=READY;gate_required=${t.gateRequired}`,
          verifiableBy: "audit 出现 RUN_* 且随后出现 GATE_* 裁决行",
        });
        break;
      case "VERIFYING":
        suggestions.push({
          id: `verifying:${t.id}`,
          subject: t.id,
          text: "已提交候选,等待 Gate 裁决(独立 Reviewer + 确定性检查)。",
          basis: "tasks.state=VERIFYING",
          verifiableBy: "task_gate_verdicts 出现绑定当前候选的裁决行",
        });
        break;
      case "ACCEPTED": {
        const cs = changesets.find((c) => c.taskId === t.id);
        suggestions.push({
          id: `accepted:${t.id}`,
          subject: t.id,
          text: cs
            ? `已通过 Gate(任务 ACCEPTED);交付状态 ${cs.deliveryState}${cs.deliveredRemoteHead ? `(远端头 ${cs.deliveredRemoteHead.slice(0, 12)})` : ""}。注意:任务 ACCEPTED ≠ Goal 已被用户验收。`
            : "已通过 Gate(任务 ACCEPTED)。注意:任务 ACCEPTED ≠ Goal 已被用户验收。",
          basis: cs ? `tasks.state=ACCEPTED;delivery_state=${cs.deliveryState}` : "tasks.state=ACCEPTED",
          verifiableBy: "candidate_changesets.delivery_state 与远端核对记录",
        });
        break;
      }
      default:
        suggestions.push({
          id: `state:${t.id}`,
          subject: t.id,
          text: `任务当前状态 ${t.state};下一步由 core 状态机裁决,控制台不代为决定。`,
          basis: `tasks.state=${t.state}`,
          verifiableBy: "tasks.state 字段",
        });
    }
  }

  if (modelCalls) {
    const remaining = (modelCalls.limit ?? 0) - modelCalls.used - modelCalls.reserved;
    suggestions.push({
      id: "budget:model_calls",
      subject: "budget",
      text:
        remaining <= 0
          ? "模型调用预算已用尽:后续 Run 会被预算门拒绝(FAIL-CLOSED)。"
          : `模型调用预算剩余 ${remaining} 次(上限 ${modelCalls.limit ?? "未设"},已用 ${modelCalls.used},预留 ${modelCalls.reserved})。`,
      basis: `budget_ledger kind=model_calls limit=${modelCalls.limit} used=${modelCalls.used} reserved=${modelCalls.reserved}`,
      verifiableBy: "budget_ledger 行随每次 Run 结算变化",
    });
  }
  const pendingD3 = decisions.filter((d) => d.level === "D3" && (d.state === "OPEN" || d.state === "EXPIRED_STILL_BLOCKED"));
  if (pendingD3.length > 0) {
    suggestions.push({
      id: "decisions:d3",
      subject: "decisions",
      text: `有 ${pendingD3.length} 项 D3 决策待人工裁决;D3 永不超时自动批准,相关任务将保持阻塞,其它任务不受影响。`,
      basis: `decisions(level=D3,state IN (OPEN,EXPIRED_STILL_BLOCKED))`,
      verifiableBy: "Decision Inbox 列表与 tasks.state",
    });
  }

  return {
    source: "deterministic",
    sourceLabel: "确定性规则推导(非模型分析)",
    understanding: {
      rawInput: goal.rawInput,
      derivedTasks: tasks.map((t) => ({
        taskId: t.id,
        allowedScope: t.allowedScope,
        allowedCommands: t.allowedCommands,
        gateRequired: t.gateRequired,
      })),
      acceptanceBasis: "验收依据 = 绑定当前候选的 Gate PASS(独立 Reviewer 裁决 + 确定性测试证据);任务 ACCEPTED 不等于 Goal 已被用户验收。",
      constraints: { budget: goal.budget },
    },
    modelAnalysis: {
      status: "NOT_IMPLEMENTED",
      note: "模型驱动的需求发现/澄清与推荐行动在本包未实现:本页『系统理解』与『可验证建议』全部由数据库事实规则推导,不含任何模型生成结论。",
    },
    suggestions,
  };
}

// ---------------- Decision Inbox ----------------

export async function decisionListView(db: RelayDb): Promise<DecisionView[]> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };
  const rows = await exec.execute(sql`
    SELECT d.id, d.task_id, d.goal_id, d.level, d.question, d.fallback, d.deadline, d.state,
           d.verdict, d.decided_by, d.decided_at, d.created_at,
           t.state AS task_state, t.state_version, t.blocked_reason
    FROM decisions d LEFT JOIN tasks t ON t.id = d.task_id
    ORDER BY (d.state IN ('OPEN','EXPIRED_STILL_BLOCKED')) DESC, d.level ASC, d.deadline ASC NULLS LAST, d.created_at ASC
  `);
  const csRows = await exec.execute(sql`
    SELECT task_id, changed_files FROM candidate_changesets
    WHERE task_id IN (SELECT DISTINCT task_id FROM decisions WHERE task_id IS NOT NULL)
  `);
  const filesByTask = new Map<string, string[]>();
  for (const r of csRows.rows) {
    const tid = str(r["task_id"]);
    const diff = json<{ added?: string[]; modified?: string[]; removed?: string[] }>(r["changed_files"], {});
    filesByTask.set(tid, [...(diff.added ?? []), ...(diff.modified ?? []), ...(diff.removed ?? [])]);
  }
  return rows.rows.map((r) => {
    const level = str(r["level"]);
    const state = str(r["state"]);
    const pending = state === "OPEN" || state === "EXPIRED_STILL_BLOCKED";
    const taskState = r["task_state"] === null || r["task_state"] === undefined ? null : str(r["task_state"]);
    const legal = taskState ? isLegalTransition(taskState, "READY") : false;
    const tid = r["task_id"] === null ? null : str(r["task_id"]);
    return {
      id: str(r["id"]),
      taskId: tid,
      goalId: r["goal_id"] === null ? null : str(r["goal_id"]),
      level,
      question: str(r["question"]),
      fallback: json<Record<string, unknown> | null>(r["fallback"], null),
      deadline: iso(r["deadline"]),
      state,
      verdict: json<Record<string, unknown> | null>(r["verdict"], null),
      decidedBy: r["decided_by"] === null ? null : str(r["decided_by"]),
      decidedAt: iso(r["decided_at"]),
      createdAt: iso(r["created_at"]) ?? "",
      taskState,
      taskStateVersion: r["state_version"] === null || r["state_version"] === undefined ? null : num(r["state_version"]),
      timeoutBehavior: TIMEOUT_BEHAVIOR[level] ?? "未登记",
      affectedFiles: tid ? filesByTask.get(tid) ?? [] : [],
      reversible: level === "D3",
      canApprove: pending && level !== "D4" && legal,
      canReject: pending && level !== "D4",
      canDefer: pending && level !== "D4",
      guidance: decisionGuidance({
        level,
        question: str(r["question"]),
        fallback: json<Record<string, unknown> | null>(r["fallback"], null),
        taskState,
        blockedReason: r["blocked_reason"] === null || r["blocked_reason"] === undefined ? null : str(r["blocked_reason"]),
        deadline: iso(r["deadline"]),
        reversible: level === "D3",
      }),
    };
  });
}

// ---------------- ChangeSet / Evidence ----------------

export interface ChangesetDetail {
  changeset: ChangesetSummary;
  task: TaskView | null;
  goal: { id: string; rawInput: string; state: string } | null;
  gates: GateVerdictView[];
  evidence: EvidenceView[];
  runs: RunView[];
  proposal: {
    id: string;
    state: string;
    capability: string;
    target: string;
    branch: string;
    expectedRemoteSha: string;
    commitSha: string;
    policyDetail: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  } | null;
  intent: { id: string; state: string; capability: string; target: string; branch: string; payloadSha: string; expectedRemoteSha: string; createdAt: string; updatedAt: string } | null;
  decisions: DecisionView[];
  /** 证据时效:绑定候选与当前候选不一致 ⇒ 需要重验 */
  evidenceFreshness: { currentCandidateSha: string; staleGateCount: number; verdict: "FRESH" | "STALE" };
}

export async function changesetDetailView(db: RelayDb, changesetId: string): Promise<ChangesetDetail | null> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };
  const cs = await exec.execute(sql`
    SELECT id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope,
           git_base_commit_sha, git_tree_sha, git_commit_sha, delivery_state, delivered_remote_head, created_at
    FROM candidate_changesets WHERE id = ${changesetId}
  `);
  const row = cs.rows[0];
  if (!row) return null;
  const taskId = str(row["task_id"]);

  const changeset: ChangesetSummary = {
    id: str(row["id"]),
    taskId,
    runId: str(row["run_id"]),
    attempt: num(row["attempt"]),
    baseSha: str(row["base_sha"]),
    candidateSha: str(row["candidate_sha"]),
    requirementSha: str(row["requirement_sha"]),
    gitBaseCommitSha: row["git_base_commit_sha"] === null ? null : str(row["git_base_commit_sha"]),
    gitTreeSha: row["git_tree_sha"] === null ? null : str(row["git_tree_sha"]),
    gitCommitSha: row["git_commit_sha"] === null ? null : str(row["git_commit_sha"]),
    changedFiles: json<ChangesetSummary["changedFiles"]>(row["changed_files"], { added: [], modified: [], removed: [] }),
    impactScope: json<ChangesetSummary["impactScope"]>(row["impact_scope"], { inScope: [], violations: [] }),
    deliveryState: str(row["delivery_state"]),
    deliveredRemoteHead: row["delivered_remote_head"] === null ? null : str(row["delivered_remote_head"]),
    createdAt: iso(row["created_at"]) ?? "",
  };

  const taskRows = await exec.execute(sql`
    SELECT id, goal_id, state, state_version, attempt, max_attempts, priority, gate_required,
           allowed_scope, allowed_commands, blocked_reason, retry_not_before, created_at, updated_at
    FROM tasks WHERE id = ${taskId}
  `);
  const trow = taskRows.rows[0];
  let task: TaskView | null = null;
  if (trow) {
    const decRows = await exec.execute(sql`
      SELECT id, level, question, state, deadline FROM decisions
      WHERE task_id = ${taskId} AND state IN ('OPEN','EXPIRED_STILL_BLOCKED') ORDER BY created_at LIMIT 1
    `);
    const d = decRows.rows[0];
    task = {
      id: taskId,
      goalId: trow["goal_id"] === null ? null : str(trow["goal_id"]),
      state: str(trow["state"]),
      stateVersion: num(trow["state_version"]),
      attempt: num(trow["attempt"]),
      maxAttempts: num(trow["max_attempts"]),
      priority: num(trow["priority"]),
      gateRequired: trow["gate_required"] === true,
      allowedScope: json<string[]>(trow["allowed_scope"], []),
      allowedCommands: json<string[]>(trow["allowed_commands"], []),
      blockedReason: trow["blocked_reason"] === null ? null : str(trow["blocked_reason"]),
      retryNotBefore: iso(trow["retry_not_before"]),
      createdAt: iso(trow["created_at"]) ?? "",
      updatedAt: iso(trow["updated_at"]) ?? "",
      openDecision: d ? { id: str(d["id"]), level: str(d["level"]), question: str(d["question"]), state: str(d["state"]), deadline: iso(d["deadline"]) } : null,
      availableActions: [],
    };
    task.availableActions = availableActionsFor(task, Boolean(d));
  }

  const gateRows = await exec.execute(sql`
    SELECT id, verdict, reviewer, attempt, candidate_sha, requirement_sha, reviewer_run_id, coder_run_id,
           evidence_ids, test_env, consumed_at, consumed_by, created_at
    FROM task_gate_verdicts WHERE task_id = ${taskId} ORDER BY created_at DESC
  `);
  const gates: GateVerdictView[] = gateRows.rows.map((r) => {
    const cand = r["candidate_sha"] === null ? null : str(r["candidate_sha"]);
    return {
      id: str(r["id"]),
      verdict: str(r["verdict"]),
      reviewer: str(r["reviewer"]),
      attempt: r["attempt"] === null ? null : num(r["attempt"]),
      candidateSha: cand,
      requirementSha: r["requirement_sha"] === null ? null : str(r["requirement_sha"]),
      reviewerRunId: r["reviewer_run_id"] === null ? null : str(r["reviewer_run_id"]),
      coderRunId: r["coder_run_id"] === null ? null : str(r["coder_run_id"]),
      evidenceIds: json<string[]>(r["evidence_ids"], []),
      testEnv: json<Record<string, unknown>>(r["test_env"], {}),
      consumedAt: iso(r["consumed_at"]),
      consumedBy: r["consumed_by"] === null ? null : str(r["consumed_by"]),
      createdAt: iso(r["created_at"]) ?? "",
      staleEvidence: cand !== null && cand !== changeset.candidateSha,
    };
  });

  const evRows = await exec.execute(sql`
    SELECT id, task_id, attempt, candidate_sha, kind, passed, raw_output, env, content_sha256, produced_by, created_at
    FROM gate_evidence WHERE task_id = ${taskId} ORDER BY created_at DESC LIMIT 100
  `);
  const evidence: EvidenceView[] = evRows.rows.map((r) => ({
    id: str(r["id"]),
    kind: str(r["kind"]),
    passed: r["passed"] === true,
    attempt: num(r["attempt"]),
    candidateSha: str(r["candidate_sha"]),
    contentSha256: str(r["content_sha256"]),
    producedBy: str(r["produced_by"]),
    createdAt: iso(r["created_at"]) ?? "",
    rawOutput: str(r["raw_output"]).slice(0, 8000),
    env: json<Record<string, unknown>>(r["env"], {}),
  }));

  const runRows = await exec.execute(sql`
    SELECT id, task_id, attempt, outcome, sandbox, model_ref, detail, started_at, ended_at
    FROM runs WHERE task_id = ${taskId} ORDER BY started_at DESC LIMIT 50
  `);
  const runs: RunView[] = runRows.rows.map((r) => {
    const detail = json<Record<string, unknown>>(r["detail"], {});
    return {
      id: str(r["id"]),
      taskId: str(r["task_id"]),
      attempt: num(r["attempt"]),
      outcome: str(r["outcome"]),
      sandbox: str(r["sandbox"]),
      modelRef: str(r["model_ref"]),
      role: detail["role"] === undefined ? null : str(detail["role"]),
      startedAt: iso(r["started_at"]) ?? "",
      endedAt: iso(r["ended_at"]),
      reason: detail["reason"] === undefined ? null : str(detail["reason"]),
      detail,
    };
  });

  const propRows = await exec.execute(sql`
    SELECT id, state, capability, target, branch, expected_remote_sha, commit_sha, policy_detail, created_at, updated_at
    FROM action_proposals WHERE changeset_id = ${changesetId} ORDER BY created_at DESC LIMIT 1
  `);
  const prow = propRows.rows[0];
  const proposal = prow
    ? {
        id: str(prow["id"]),
        state: str(prow["state"]),
        capability: str(prow["capability"]),
        target: str(prow["target"]),
        branch: str(prow["branch"]),
        expectedRemoteSha: str(prow["expected_remote_sha"]),
        commitSha: str(prow["commit_sha"]),
        policyDetail: json<Record<string, unknown>>(prow["policy_detail"], {}),
        createdAt: iso(prow["created_at"]) ?? "",
        updatedAt: iso(prow["updated_at"]) ?? "",
      }
    : null;

  let intent: ChangesetDetail["intent"] = null;
  if (prow) {
    const iRows = await exec.execute(sql`
      SELECT id, state, capability, target, branch, payload_sha, expected_remote_sha, created_at, updated_at
      FROM action_intents WHERE task_id = ${taskId} AND payload_sha = ${str(prow["commit_sha"])} ORDER BY created_at DESC LIMIT 1
    `);
    const i = iRows.rows[0];
    if (i) {
      intent = {
        id: str(i["id"]),
        state: str(i["state"]),
        capability: str(i["capability"]),
        target: str(i["target"]),
        branch: str(i["branch"]),
        payloadSha: str(i["payload_sha"]),
        expectedRemoteSha: str(i["expected_remote_sha"]),
        createdAt: iso(i["created_at"]) ?? "",
        updatedAt: iso(i["updated_at"]) ?? "",
      };
    }
  }

  const decRows = await exec.execute(sql`
    SELECT id, task_id, goal_id, level, question, fallback, deadline, state, verdict, decided_by, decided_at, created_at
    FROM decisions WHERE task_id = ${taskId} ORDER BY created_at DESC
  `);
  const decisions: DecisionView[] = decRows.rows.map((r) => {
    const level = str(r["level"]);
    const state = str(r["state"]);
    const pending = state === "OPEN" || state === "EXPIRED_STILL_BLOCKED";
    const legal = task ? isLegalTransition(task.state, "READY") : false;
    return {
      id: str(r["id"]),
      taskId: str(r["task_id"]),
      goalId: r["goal_id"] === null ? null : str(r["goal_id"]),
      level,
      question: str(r["question"]),
      fallback: json<Record<string, unknown> | null>(r["fallback"], null),
      deadline: iso(r["deadline"]),
      state,
      verdict: json<Record<string, unknown> | null>(r["verdict"], null),
      decidedBy: r["decided_by"] === null ? null : str(r["decided_by"]),
      decidedAt: iso(r["decided_at"]),
      createdAt: iso(r["created_at"]) ?? "",
      taskState: task?.state ?? null,
      taskStateVersion: task?.stateVersion ?? null,
      timeoutBehavior: TIMEOUT_BEHAVIOR[level] ?? "未登记",
      affectedFiles: [...changeset.changedFiles.added, ...changeset.changedFiles.modified, ...changeset.changedFiles.removed],
      reversible: level === "D3",
      canApprove: pending && level !== "D4" && legal,
      canReject: pending && level !== "D4",
      canDefer: pending && level !== "D4",
      guidance: decisionGuidance({
        level,
        question: str(r["question"]),
        fallback: json<Record<string, unknown> | null>(r["fallback"], null),
        taskState: task?.state ?? null,
        blockedReason: task?.blockedReason ?? null,
        deadline: iso(r["deadline"]),
        reversible: level === "D3",
      }),
    };
  });

  let goal: ChangesetDetail["goal"] = null;
  if (task?.goalId) {
    const gRows = await exec.execute(sql`SELECT id, raw_input, state FROM goals WHERE id = ${task.goalId}`);
    const g = gRows.rows[0];
    if (g) goal = { id: str(g["id"]), rawInput: str(g["raw_input"]), state: str(g["state"]) };
  }

  const staleGateCount = gates.filter((g) => g.staleEvidence).length;
  return {
    changeset,
    task,
    goal,
    gates,
    evidence,
    runs,
    proposal,
    intent,
    decisions,
    evidenceFreshness: {
      currentCandidateSha: changeset.candidateSha,
      staleGateCount,
      verdict: staleGateCount > 0 ? "STALE" : "FRESH",
    },
  };
}

export const LIFECYCLE_STATES: readonly TaskState[] = Object.keys(TRANSITIONS) as TaskState[];

/** 变更集列表(ChangeSet 页的选择器)。 */
export async function changesetListView(db: RelayDb): Promise<ChangesetSummary[]> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };
  const rows = await exec.execute(sql`
    SELECT id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope,
           git_base_commit_sha, git_tree_sha, git_commit_sha, delivery_state, delivered_remote_head, created_at
    FROM candidate_changesets ORDER BY created_at DESC LIMIT 200
  `);
  return rows.rows.map((r) => ({
    id: str(r["id"]),
    taskId: str(r["task_id"]),
    runId: str(r["run_id"]),
    attempt: num(r["attempt"]),
    baseSha: str(r["base_sha"]),
    candidateSha: str(r["candidate_sha"]),
    requirementSha: str(r["requirement_sha"]),
    gitBaseCommitSha: r["git_base_commit_sha"] === null ? null : str(r["git_base_commit_sha"]),
    gitTreeSha: r["git_tree_sha"] === null ? null : str(r["git_tree_sha"]),
    gitCommitSha: r["git_commit_sha"] === null ? null : str(r["git_commit_sha"]),
    changedFiles: json<ChangesetSummary["changedFiles"]>(r["changed_files"], { added: [], modified: [], removed: [] }),
    impactScope: json<ChangesetSummary["impactScope"]>(r["impact_scope"], { inScope: [], violations: [] }),
    deliveryState: str(r["delivery_state"]),
    deliveredRemoteHead: r["delivered_remote_head"] === null ? null : str(r["delivered_remote_head"]),
    createdAt: iso(r["created_at"]) ?? "",
  }));
}

// ---------------- Operator Console 扩展(OPERATOR-CONSOLE-00) ----------------
// 同一铁律:只读 SELECT;零模型调用;所有"当前值"都是 DB/本地事实,不探测 Provider(0 次推理请求)。

const IN_FLIGHT_STATES = ["LEASED", "RUNNING", "SUBMITTED", "VERIFYING"];

/** 任务状态 ⇒ 操作面四分组(进行中/可排队/等待·受阻/失败;完成单列)。 */
export function groupTaskCounts(taskCounts: TaskStateCounts): {
  inFlight: number;
  ready: number;
  waiting: number;
  failed: number;
  done: number;
} {
  const pick = (states: string[]): number => states.reduce((a, s) => a + (taskCounts[s] ?? 0), 0);
  return {
    inFlight: pick(IN_FLIGHT_STATES),
    ready: pick(["CREATED", "READY", "REWORK"]),
    waiting: pick(["NEEDS_DECISION", "PAUSED", "BLOCKED", "NEEDS_RECONCILE"]),
    failed: pick(["FAILED"]),
    done: pick(["ACCEPTED", "CANCELLED"]),
  };
}

export interface DashboardExtras {
  overall: { status: "normal" | "attention" | "blocked"; basis: string };
  currentGoal: { id: string; rawInput: string; state: string; updatedAt: string; inFlightTaskId: string | null; inFlightState: string | null } | null;
  taskGroups: ReturnType<typeof groupTaskCounts>;
  deliverySummary: { byState: Record<string, number>; deliveredTotal: number; lastDeliveredAt: string | null };
  lastModel: { modelRef: string | null; source: "run" | "discovery" | null; at: string | null };
  lastWorkerHeartbeat: string | null;
  recentCompleted: Array<{ taskId: string; goalId: string | null; deliveryState: string; commitSha: string | null; deliveredAt: string | null; changedFiles: number }>;
}

/** P0-UI-1 增强:当前 Goal / 任务分组 / Delivery 汇总 / 最近模型事实 / Worker 心跳 / 最近完成。 */
export async function dashboardExtrasView(db: RelayDb): Promise<DashboardExtras> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };
  const allCounts = await exec.execute(sql`SELECT state, count(*)::int AS n FROM tasks GROUP BY state`);
  const taskCounts: TaskStateCounts = {};
  for (const r of allCounts.rows) taskCounts[str(r["state"])] = num(r["n"]);

  const inFlight = await exec.execute(sql`
    SELECT t.id, t.goal_id, t.state, t.updated_at, g.raw_input, g.state AS goal_state, g.updated_at AS goal_updated_at
    FROM tasks t LEFT JOIN goals g ON g.id = t.goal_id
    WHERE t.state IN ('LEASED','RUNNING','SUBMITTED','VERIFYING')
    ORDER BY t.updated_at DESC LIMIT 1
  `);
  let currentGoal: DashboardExtras["currentGoal"] = null;
  if (inFlight.rows.length > 0) {
    const r = inFlight.rows[0]!;
    currentGoal = {
      id: str(r["goal_id"]),
      rawInput: str(r["raw_input"]),
      state: str(r["goal_state"]),
      updatedAt: iso(r["goal_updated_at"]) ?? "",
      inFlightTaskId: str(r["id"]),
      inFlightState: str(r["state"]),
    };
  } else {
    const latestActive = await exec.execute(sql`
      SELECT id, raw_input, state, updated_at FROM goals WHERE state IN ('ACTIVE','PAUSED')
      ORDER BY updated_at DESC LIMIT 1
    `);
    if (latestActive.rows.length > 0) {
      const r = latestActive.rows[0]!;
      currentGoal = {
        id: str(r["id"]),
        rawInput: str(r["raw_input"]),
        state: str(r["state"]),
        updatedAt: iso(r["updated_at"]) ?? "",
        inFlightTaskId: null,
        inFlightState: null,
      };
    }
  }

  const deliveryRows = await exec.execute(sql`
    SELECT delivery_state, count(*)::int AS n FROM candidate_changesets GROUP BY delivery_state
  `);
  const byState: Record<string, number> = {};
  for (const r of deliveryRows.rows) byState[str(r["delivery_state"])] = num(r["n"]);
  const lastDelivered = await exec.execute(sql`
    SELECT max(delivered_at) AS at FROM candidate_changesets WHERE delivery_state = 'DELIVERED'
  `);

  const lastRunModel = await exec.execute(sql`
    SELECT model_ref, started_at FROM runs ORDER BY started_at DESC LIMIT 1
  `);
  const lastDiscoveryModel = await exec.execute(sql`
    SELECT model_ref, created_at FROM discoveries ORDER BY created_at DESC LIMIT 1
  `);
  let lastModel: DashboardExtras["lastModel"] = { modelRef: null, source: null, at: null };
  const runAt = lastRunModel.rows.length ? iso(lastRunModel.rows[0]!["started_at"]) : null;
  const discAt = lastDiscoveryModel.rows.length ? iso(lastDiscoveryModel.rows[0]!["created_at"]) : null;
  if (runAt || discAt) {
    const useRun = Boolean(runAt) && (!discAt || String(runAt) >= String(discAt));
    const src = useRun ? lastRunModel.rows[0]! : lastDiscoveryModel.rows[0]!;
    lastModel = {
      modelRef: str(src["model_ref"]),
      source: useRun ? "run" : "discovery",
      at: useRun ? runAt : discAt,
    };
  }

  const heartbeat = await exec.execute(sql`SELECT max(heartbeat_at) AS at FROM leases`);

  const completed = await exec.execute(sql`
    SELECT cc.task_id, t.goal_id, cc.delivery_state, cc.git_commit_sha, cc.delivered_at, cc.changed_files
    FROM candidate_changesets cc LEFT JOIN tasks t ON t.id = cc.task_id
    WHERE cc.delivery_state IN ('DELIVERED','CONFLICT','FAILED')
    ORDER BY cc.delivered_at DESC NULLS LAST, cc.created_at DESC LIMIT 5
  `);
  const recentCompleted = completed.rows.map((r) => {
    const files = json<{ added?: string[]; modified?: string[]; removed?: string[] }>(r["changed_files"], {});
    return {
      taskId: str(r["task_id"]),
      goalId: r["goal_id"] === null ? null : str(r["goal_id"]),
      deliveryState: str(r["delivery_state"]),
      commitSha: r["git_commit_sha"] === null ? null : str(r["git_commit_sha"]),
      deliveredAt: iso(r["delivered_at"]),
      changedFiles: (files.added ?? []).length + (files.modified ?? []).length + (files.removed ?? []).length,
    };
  });

  const groups = groupTaskCounts(taskCounts);
  const badSignals = groups.failed + groups.waiting + (byState["CONFLICT"] ?? 0) + (byState["FAILED"] ?? 0);
  const overall: DashboardExtras["overall"] = badSignals > 0
    ? { status: "blocked", basis: "存在失败/等待人工/交付异常信号 " + badSignals + " 项" }
    : groups.inFlight > 0 || groups.done > 0
      ? { status: "normal", basis: "无阻塞信号;任务在推进" }
      : { status: "normal", basis: "空闲(无任务或全部完成)" };

  return {
    overall,
    currentGoal,
    taskGroups: groups,
    deliverySummary: {
      byState,
      deliveredTotal: byState["DELIVERED"] ?? 0,
      lastDeliveredAt: iso(lastDelivered.rows[0]?.["at"]),
    },
    lastModel,
    lastWorkerHeartbeat: iso(heartbeat.rows[0]?.["at"]),
    recentCompleted,
  };
}

// ---------------- Goal 执行进度(P0-UI-3) ----------------

export interface GoalProgress {
  phase: string;
  phaseBasis: string;
  currentTaskId: string | null;
  currentModelRef: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  elapsedSeconds: number | null;
  delivered: boolean;
  counts: { runs: number; evidence: number; gates: number; openDecisions: number };
}

/** 确定性阶段推导(非模型):从任务状态/证据/交付状态唯一事实推导操作面阶段。 */
export function deriveGoalPhase(input: {
  goalState: string;
  tasks: Array<{ id: string; state: string }>;
  runs: Array<{ outcome: string; modelRef: string; startedAt: string }>;
  changesets: Array<{ deliveryState: string; deliveredAt: string | null }>;
  openDecisions: number;
  evidenceCount: number;
  gateCount: number;
  nowMs: number;
}): GoalProgress {
  const inFlight = input.tasks.find((t) => IN_FLIGHT_STATES.includes(t.state));
  const needsHuman = input.tasks.find((t) => ["NEEDS_DECISION", "NEEDS_RECONCILE", "BLOCKED", "PAUSED"].includes(t.state));
  const failed = input.tasks.find((t) => t.state === "FAILED");
  const done = input.tasks.length > 0 && input.tasks.every((t) => t.state === "ACCEPTED" || t.state === "CANCELLED");
  const delivered = input.changesets.some((c) => c.deliveryState === "DELIVERED");
  const delivering = input.changesets.some((c) => c.deliveryState === "DELIVERING");

  let phase = "排队中";
  let basis = "任务尚未被领取";
  if (delivered) {
    phase = "已交付";
    basis = "存在 DELIVERED 变更集(远端已核对)";
  } else if (delivering) {
    phase = "交付中";
    basis = "变更集处于 DELIVERING";
  } else if (done) {
    phase = "已完成";
    basis = "全部任务 ACCEPTED/CANCELLED";
  } else if (inFlight) {
    if (inFlight.state === "VERIFYING" || inFlight.state === "SUBMITTED") {
      phase = input.gateCount > 0 || input.evidenceCount > 0 ? "审查中" : "验证中";
      basis = "任务 " + inFlight.id + " 处于 " + inFlight.state;
    } else {
      phase = "执行中";
      basis = "任务 " + inFlight.id + " 处于 " + inFlight.state;
    }
  } else if (needsHuman) {
    phase = needsHuman.state === "PAUSED" ? "已暂停" : needsHuman.state === "NEEDS_DECISION" ? "等待人工决策" : "已阻塞";
    basis = "任务 " + needsHuman.id + " 处于 " + needsHuman.state;
  } else if (failed && input.tasks.every((t) => !IN_FLIGHT_STATES.includes(t.state))) {
    phase = "失败";
    basis = "任务 " + failed.id + " 处于 FAILED";
  } else if (input.tasks.some((t) => t.state === "REWORK")) {
    phase = "返工中";
    basis = "存在 REWORK 任务";
  }

  const startedAt = input.runs.length > 0 ? input.runs[input.runs.length - 1]!.startedAt : null;
  const lastActivityAt = input.runs.length > 0 ? input.runs[0]!.startedAt : null;
  const elapsedSeconds = startedAt
    ? Math.max(0, Math.round((input.nowMs - new Date(startedAt).getTime()) / 1000))
    : null;

  return {
    phase,
    phaseBasis: basis,
    currentTaskId: inFlight ? inFlight.id : needsHuman ? needsHuman.id : failed ? failed.id : null,
    currentModelRef: input.runs.length > 0 ? input.runs[0]!.modelRef : null,
    startedAt,
    lastActivityAt,
    elapsedSeconds,
    delivered,
    counts: {
      runs: input.runs.length,
      evidence: input.evidenceCount,
      gates: input.gateCount,
      openDecisions: input.openDecisions,
    },
  };
}

// ---------------- Projects(P0-UI-2;注册文件驱动,零 schema 变更) ----------------

export interface ProjectView {
  name: string;
  path: string;
  repo: string | null;
  branch: string | null;
  health: "ok" | "unreachable";
  healthDetail: string | null;
  gitBranch: string | null;
  gitHead: string | null;
  recentGoals: Array<{ id: string; rawInput: string; state: string; updatedAt: string }>;
  goalCount: number;
}

export interface ProjectsView {
  source: string | null;
  configured: boolean;
  note: string;
  projects: ProjectView[];
}

function repoRootFromModule(): string {
  // src/server/views.ts ⇒ 仓库根(与 process.cwd 解耦)
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function readProjectRegistry(): { source: string | null; projects: Array<{ name: string; path: string; repo?: string; branch?: string }> } {
  const explicit = process.env.RELAY_PROJECTS_FILE;
  const defaultRegistryPath = join(repoRootFromModule(), "config", "projects.json");
  const file = explicit && explicit.trim() ? explicit : defaultRegistryPath;
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { projects?: unknown };
    const list = Array.isArray(parsed.projects) ? parsed.projects : [];
    return {
      source: file,
      projects: list
        .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
        .slice(0, 20)
        .map((p) => ({
          name: typeof p["name"] === "string" ? p["name"] : basename(String(p["path"] ?? "project")),
          path: typeof p["path"] === "string" ? p["path"] : "",
          repo: typeof p["repo"] === "string" ? p["repo"] : undefined,
          branch: typeof p["branch"] === "string" ? p["branch"] : undefined,
        }))
        .filter((p) => p.path.length > 0),
    };
  } catch {
    return { source: file, projects: [] };
  }
}

function localGitFacts(path: string): { exists: boolean; gitBranch: string | null; gitHead: string | null; detail: string | null } {
  try {
    statSync(path);
  } catch {
    return { exists: false, gitBranch: null, gitHead: null, detail: "目录不存在或不可读" };
  }
  const run = (args: string[]): string | null => {
    try {
      return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      return null;
    }
  };
  const head = run(["rev-parse", "HEAD"]);
  if (!head) return { exists: true, gitBranch: null, gitHead: null, detail: "存在但不是可读的 git 工作树" };
  return { exists: true, gitBranch: run(["rev-parse", "--abbrev-ref", "HEAD"]), gitHead: head, detail: null };
}

/** P0-UI-2:最小项目列表(注册文件 + 本地只读 git 事实 + 经 allowed_scope 关联的最近 Goal)。 */
export async function projectsView(db: RelayDb): Promise<ProjectsView> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };
  const registry = readProjectRegistry();
  const note =
    registry.projects.length === 0
      ? "未配置项目注册文件(config/projects.json 或 RELAY_PROJECTS_FILE);格式:{\"projects\":[{\"name\",\"path\",\"repo\",\"branch\"}]}。本页仅观察,不调度。"
      : "来源=项目注册文件;健康=本地目录/git 只读事实;Goal 关联经任务 allowed_scope 前缀匹配(当前 Goal 创建流未绑定项目时显示为空)。";
  const projects: ProjectView[] = [];
  for (const entry of registry.projects) {
    const facts = localGitFacts(entry.path);
    const link = await exec.execute(sql`
      SELECT g.id, g.raw_input, g.state, g.updated_at
      FROM tasks t
      JOIN jsonb_array_elements_text(t.allowed_scope) s ON true
      JOIN goals g ON g.id = t.goal_id
      WHERE ${entry.path} LIKE s || '%'
      ORDER BY g.updated_at DESC
    `);
    const seen = new Set<string>();
    const recentGoals: ProjectView["recentGoals"] = [];
    let goalCount = 0;
    for (const r of link.rows) {
      const gid = str(r["id"]);
      if (seen.has(gid)) continue;
      seen.add(gid);
      goalCount += 1;
      if (recentGoals.length < 3) {
        recentGoals.push({ id: gid, rawInput: str(r["raw_input"]), state: str(r["state"]), updatedAt: iso(r["updated_at"]) ?? "" });
      }
    }
    projects.push({
      name: entry.name,
      path: entry.path,
      repo: entry.repo ?? null,
      branch: entry.branch ?? null,
      health: facts.exists && facts.gitHead ? "ok" : "unreachable",
      healthDetail: facts.detail,
      gitBranch: facts.gitBranch,
      gitHead: facts.gitHead,
      recentGoals,
      goalCount,
    });
  }
  return { source: registry.source, configured: registry.projects.length > 0, note, projects };
}

// ---------------- Models / Usage(P0-UI-5;纯观察) ----------------

export interface ModelsUsageView {
  provider: {
    configured: boolean;
    providerName: string | null;
    modelName: string | null;
    baseUrlHost: string | null;
    probed: false;
    note: string;
  };
  classification: { status: "UNREGISTERED"; note: string };
  recentRuns: Array<{ id: string; taskId: string; modelRef: string; outcome: string; sandbox: string; role: string | null; startedAt: string; endedAt: string | null; durationMs: number | null }>;
  recentDiscoveries: Array<{ id: string; goalId: string; modelRef: string; outcome: string; reason: string | null; createdAt: string }>;
  budgetTotals: { modelCalls: { limit: number | null; reserved: number; used: number }; tokensInUsed: number; tokensOutUsed: number; wallSecondsUsed: number };
  perGoal: Array<{ goalId: string; rawInput: string; limit: number | null; reserved: number; used: number }>;
  outcomes: { byOutcome: Record<string, number>; reasons: Array<{ reason: string; n: number }> };
}

/** P0-UI-5:模型观察面。零探测(probed 恒 false);Key/凭据零返回(redact 兜底之外本层就不取)。 */
export async function modelsUsageView(db: RelayDb): Promise<ModelsUsageView> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };
  const providerName = process.env.RELAY_PI_PROVIDER ?? null;
  const modelName = process.env.RELAY_PI_MODEL ?? null;
  const baseUrl = process.env.RELAY_PI_BASE_URL ?? null;
  let baseUrlHost: string | null = null;
  if (baseUrl) {
    try {
      baseUrlHost = new URL(baseUrl).host;
    } catch {
      baseUrlHost = null;
    }
  }

  const runRows = await exec.execute(sql`
    SELECT id, task_id, model_ref, outcome, sandbox, detail->>'role' AS role, started_at, ended_at
    FROM runs ORDER BY started_at DESC LIMIT 30
  `);
  const recentRuns = runRows.rows.map((r) => {
    const s = iso(r["started_at"]);
    const e = iso(r["ended_at"]);
    const durationMs = s && e ? new Date(e).getTime() - new Date(s).getTime() : null;
    return {
      id: str(r["id"]),
      taskId: str(r["task_id"]),
      modelRef: str(r["model_ref"]),
      outcome: str(r["outcome"]),
      sandbox: str(r["sandbox"]),
      role: r["role"] === null ? null : str(r["role"]),
      startedAt: s ?? "",
      endedAt: e,
      durationMs,
    };
  });

  const discRows = await exec.execute(sql`
    SELECT id, goal_id, model_ref, outcome, reason, created_at
    FROM discoveries ORDER BY created_at DESC LIMIT 10
  `);

  const outcomeRows = await exec.execute(sql`
    SELECT outcome, count(*)::int AS n FROM runs GROUP BY outcome
  `);
  const byOutcome: Record<string, number> = {};
  for (const r of outcomeRows.rows) byOutcome[str(r["outcome"])] = num(r["n"]);
  const reasonRows = await exec.execute(sql`
    SELECT detail->>'reason' AS reason, count(*)::int AS n FROM runs
    WHERE outcome IN ('FAILED','TIMEOUT','INTERRUPTED','CANCELLED') AND detail->>'reason' IS NOT NULL
    GROUP BY detail->>'reason' ORDER BY n DESC LIMIT 10
  `);

  const totalsRows = await exec.execute(sql`
    SELECT kind, sum(coalesce(limit_value, 0)) AS limit_sum, sum(reserved) AS reserved_sum, sum(used) AS used_sum
    FROM budget_ledger GROUP BY kind
  `);
  const byKind = new Map<string, { limitSum: number; reserved: number; used: number }>();
  let hasModelLimit = false;
  for (const r of totalsRows.rows) {
    const kind = str(r["kind"]);
    const limitSum = num(r["limit_sum"]);
    if (kind === "model_calls" && num(r["limit_sum"]) > 0) hasModelLimit = true;
    byKind.set(kind, { limitSum, reserved: num(r["reserved_sum"]), used: num(r["used_sum"]) });
  }
  const mc = byKind.get("model_calls");
  const perGoalRows = await exec.execute(sql`
    SELECT bl.scope_id AS goal_id, g.raw_input, bl.limit_value, bl.reserved, bl.used
    FROM budget_ledger bl LEFT JOIN goals g ON g.id = bl.scope_id
    WHERE bl.scope_type = 'goal' AND bl.kind = 'model_calls'
    ORDER BY bl.updated_at DESC LIMIT 50
  `);

  return {
    provider: {
      configured: Boolean(providerName && modelName && baseUrl),
      providerName,
      modelName,
      baseUrlHost,
      probed: false,
      note: "本页零模型探测;是否可用以运行时事实(runs/discoveries)为准。凭据一律不显示。",
    },
    classification: {
      status: "UNREGISTERED",
      note: "Provider Registry 属 MODEL-POLICY-01(ADR-0009 设计冻结,激活前置=MVP 最终 ACCEPTED);当前仅记录 model_ref 原文,本地/云端分类不伪造。",
    },
    recentRuns,
    recentDiscoveries: discRows.rows.map((r) => ({
      id: str(r["id"]),
      goalId: str(r["goal_id"]),
      modelRef: str(r["model_ref"]),
      outcome: str(r["outcome"]),
      reason: r["reason"] === null ? null : str(r["reason"]),
      createdAt: iso(r["created_at"]) ?? "",
    })),
    budgetTotals: {
      modelCalls: {
        limit: hasModelLimit && mc ? mc.limitSum : null,
        reserved: mc ? mc.reserved : 0,
        used: mc ? mc.used : 0,
      },
      tokensInUsed: byKind.get("tokens_in")?.used ?? 0,
      tokensOutUsed: byKind.get("tokens_out")?.used ?? 0,
      wallSecondsUsed: byKind.get("wall_seconds")?.used ?? 0,
    },
    perGoal: perGoalRows.rows.map((r) => ({
      goalId: str(r["goal_id"]),
      rawInput: str(r["raw_input"]),
      limit: r["limit_value"] === null ? null : num(r["limit_value"]),
      reserved: num(r["reserved"]),
      used: num(r["used"]),
    })),
    outcomes: {
      byOutcome,
      reasons: reasonRows.rows.map((r) => ({ reason: str(r["reason"]), n: num(r["n"]) })),
    },
  };
}

// ---------------- System(P0-UI-6) ----------------

export interface SystemView {
  relay: { head: string | null; headShort: string | null; version: string; startedAt: string; uptimeSeconds: number; node: string };
  db: { ok: boolean; serverVersion: string | null; schema: string | null; error: string | null };
  worker: { mode: string; active: boolean; lastTick: { status: string; at: string } | null; activeLeases: number; lastLeaseHeartbeat: string | null };
  github: { deliveryByState: Record<string, number>; lastDeliveredAt: string | null; recentIntents: Array<{ id: string; capability: string; state: string; target: string; updatedAt: string }> };
  provider: { configured: boolean; providerName: string | null; modelName: string | null; probed: false; lastModelRef: string | null; note: string };
  recentErrors: Array<{ kind: string; subject: string; detail: string; ts: string | null }>;
}

let cachedHead: { sha: string | null; at: number } = { sha: null, at: 0 };

/** 本仓库 HEAD(1h 缓存;只读 git rev-parse,零网络)。 */
export function relayHead(force = false): string | null {
  const now = Date.now();
  if (!force && cachedHead.sha && now - cachedHead.at < 3600_000) return cachedHead.sha;
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRootFromModule(),
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    cachedHead = { sha: sha || null, at: now };
    return cachedHead.sha;
  } catch {
    cachedHead = { sha: null, at: now };
    return null;
  }
}

export interface WorkerRuntimeInfo {
  mode: string;
  active: boolean;
  lastTick: { status: string; at: string } | null;
}

/** P0-UI-6:系统页(HEAD/DB/Worker/GitHub/Provider/uptime/最近错误;全部只读事实)。 */
export async function systemView(db: RelayDb, workerInfo: WorkerRuntimeInfo): Promise<SystemView> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };

  let dbOk = true;
  let dbError: string | null = null;
  let serverVersion: string | null = null;
  try {
    const v = await exec.execute(sql`SELECT version() AS v`);
    serverVersion = str(v.rows[0]?.["v"]) || null;
  } catch (err) {
    dbOk = false;
    dbError = err instanceof Error ? err.message : String(err);
  }

  const leaseRows = await exec.execute(sql`
    SELECT count(*)::int AS n, max(heartbeat_at) AS at FROM leases
    WHERE lease_expires_at > now()
  `);

  const deliveryRows = await exec.execute(sql`
    SELECT delivery_state, count(*)::int AS n FROM candidate_changesets GROUP BY delivery_state
  `);
  const deliveryByState: Record<string, number> = {};
  for (const r of deliveryRows.rows) deliveryByState[str(r["delivery_state"])] = num(r["n"]);
  const lastDelivered = await exec.execute(sql`
    SELECT max(delivered_at) AS at FROM candidate_changesets WHERE delivery_state = 'DELIVERED'
  `);
  const intentRows = await exec.execute(sql`
    SELECT id, capability, state, target, updated_at FROM action_intents
    ORDER BY updated_at DESC LIMIT 8
  `);

  const lastModel = await exec.execute(sql`SELECT model_ref FROM runs ORDER BY started_at DESC LIMIT 1`);

  const errRuns = await exec.execute(sql`
    SELECT id, outcome, detail->>'reason' AS reason, started_at FROM runs
    WHERE outcome IN ('FAILED','TIMEOUT','INTERRUPTED','CANCELLED') ORDER BY started_at DESC LIMIT 5
  `);
  const errDelivery = await exec.execute(sql`
    SELECT id, delivery_state, task_id, created_at FROM candidate_changesets
    WHERE delivery_state IN ('CONFLICT','FAILED') ORDER BY created_at DESC LIMIT 3
  `);
  const errAudit = await exec.execute(sql`
    SELECT seq, action, detail, ts FROM audit_events
    WHERE action LIKE '%FAILED%' OR action LIKE '%REJECTED%' ORDER BY seq DESC LIMIT 5
  `);
  const recentErrors: SystemView["recentErrors"] = [];
  for (const r of errRuns.rows) {
    recentErrors.push({ kind: "run_" + str(r["outcome"]).toLowerCase(), subject: str(r["id"]), detail: str(r["reason"]) || "无原因记录", ts: iso(r["started_at"]) });
  }
  for (const r of errDelivery.rows) {
    recentErrors.push({ kind: "delivery_" + str(r["delivery_state"]).toLowerCase(), subject: str(r["id"]), detail: "任务 " + str(r["task_id"]) + " 交付异常", ts: iso(r["created_at"]) });
  }
  for (const r of errAudit.rows) {
    const detail = json<Record<string, unknown>>(r["detail"], {});
    recentErrors.push({ kind: str(r["action"]), subject: "#" + num(r["seq"]), detail: typeof detail["reason"] === "string" ? String(detail["reason"]) : "", ts: iso(r["ts"]) });
  }

  const head = relayHead();
  return {
    relay: {
      head,
      headShort: head ? head.slice(0, 10) : null,
      version: "0.1.0-p0",
      startedAt: serverStartedAt,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
    },
    db: { ok: dbOk, serverVersion, schema: process.env.RELAY_DB_SCHEMA ?? null, error: dbError },
    worker: {
      mode: workerInfo.mode,
      active: workerInfo.active,
      lastTick: workerInfo.lastTick,
      activeLeases: leaseRows.rows.length ? num(leaseRows.rows[0]!["n"]) : 0,
      lastLeaseHeartbeat: iso(leaseRows.rows[0]?.["at"]),
    },
    github: {
      deliveryByState,
      lastDeliveredAt: iso(lastDelivered.rows[0]?.["at"]),
      recentIntents: intentRows.rows.map((r) => ({
        id: str(r["id"]),
        capability: str(r["capability"]),
        state: str(r["state"]),
        target: str(r["target"]),
        updatedAt: iso(r["updated_at"]) ?? "",
      })),
    },
    provider: {
      configured: Boolean(process.env.RELAY_PI_PROVIDER && process.env.RELAY_PI_MODEL && process.env.RELAY_PI_BASE_URL),
      providerName: process.env.RELAY_PI_PROVIDER ?? null,
      modelName: process.env.RELAY_PI_MODEL ?? null,
      probed: false,
      lastModelRef: lastModel.rows.length ? str(lastModel.rows[0]!["model_ref"]) : null,
      note: "零探测;最近 model_ref 来自 runs 原始事实。",
    },
    recentErrors: recentErrors.slice(0, 10),
  };
}

// ---------------- Goal 详情进度装配 ----------------

/** 在 goalDetailView 基础上补 progress(OPERATOR-CONSOLE-00;复用同函数的查询结果,单独入口便于测试)。 */
export function buildGoalProgress(args: {
  goalState: string;
  tasks: Array<{ id: string; state: string }>;
  runs: Array<{ outcome: string; modelRef: string; startedAt: string }>;
  changesets: Array<{ deliveryState: string; deliveredAt: string | null }>;
  openDecisions: number;
  evidenceCount: number;
  gateCount: number;
  nowMs?: number;
}): GoalProgress {
  return deriveGoalPhase({ ...args, nowMs: args.nowMs ?? Date.now() });
}

