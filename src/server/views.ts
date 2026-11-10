// 只读视图(P0-02C D-4)。
// 铁律:本文件**只含 SELECT**。它把 PostgreSQL(唯一业务事实源)里的行聚合成页面/接口
// 需要的形状;**不产生状态、不写库、不复制第二套状态机**。
// 任何状态转移都必须回到 src/core/*(D-3)。
// 可用动作(availableActions)由 core 的转移表(TRANSITIONS/isLegalTransition)裁决 ——
// 界面不能提供 core 会拒绝的转移。
import { sql } from "drizzle-orm";
import type { RelayDb } from "../core/db.ts";
import { TRANSITIONS, isLegalTransition, type TaskState } from "../core/lifecycle.ts";
import { ledgerSnapshot } from "../core/budget.ts";

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
}

export interface GoalAnalysis {
  /** 分析来源标注 —— 恒为 deterministic(非模型) */
  source: "deterministic";
  sourceLabel: string;
  understanding: {
    rawInput: string;
    derivedTasks: Array<{ taskId: string; goalText: string; allowedScope: string[]; allowedCommands: string[]; gateRequired: boolean }>;
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
        goalText: t.id,
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
           t.state AS task_state, t.state_version
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
