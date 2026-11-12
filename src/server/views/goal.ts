// 只读视图·Goal(WEB-UX-01 §4.3 自 src/server/views.ts 拆分;行为不变;只含 SELECT)。
import { sql } from "drizzle-orm";
import type { RelayDb } from "../../core/db.ts";
import { TRANSITIONS, isLegalTransition, type TaskState } from "../../core/lifecycle.ts";
import { ledgerSnapshot } from "../../core/budget.ts";
import {
  iso,
  num,
  str,
  json,
  type Row,
  type TaskStateCounts,
  type TaskView,
  type EvidenceView,
  type GateVerdictView,
  type ChangesetSummary,
  type RunView,
  type DecisionView,
  availableActionsFor,
  decisionGuidance,
  TIMEOUT_BEHAVIOR,
  IN_FLIGHT_STATES,
} from "./shared.ts";

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

export const LIFECYCLE_STATES: readonly TaskState[] = Object.keys(TRANSITIONS) as TaskState[];

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

// ─── WEB-UX-03 03B:Goal Feed 读模型(纯投影;goal_messages 为会话事实,Core 表为执行事实) ───

export interface GoalFeedItem {
  id: number;
  kind: string;
  actor: string;
  content: string;
  createdAt: string | null;
}

export interface GoalFeedDecision {
  id: string;
  taskId: string;
  level: string;
  question: string;
  fallback: Record<string, unknown>;
  deadline: string | null;
  createdAt: string | null;
}

export interface GoalFeedView {
  goalId: string;
  cursor: number | null;
  nextCursor: number | null;
  hasMore: boolean;
  items: GoalFeedItem[];
  decisions: GoalFeedDecision[];
  status: GoalStatusView;
}

export interface GoalStatusView {
  goalId: string;
  goalState: string;
  rawInput: string;
  inFlight: boolean;
  tasks: Array<{ id: string; state: string; priority: number; updatedAt: string | null }>;
  pendingDecisions: number;
}

/** Goal 是否有在途执行(LEASED/RUNNING/SUBMITTED/VERIFYING)。follow-up 派生的前置检查。 */
export async function goalHasInFlightRun(db: RelayDb, goalId: string): Promise<boolean> {
  const states = sql.join(IN_FLIGHT_STATES.map((s) => sql`${s}`), sql`, `);
  const rows = await db.execute(sql`
    SELECT 1 FROM tasks
    WHERE goal_id = ${goalId} AND state IN (${states})
    LIMIT 1
  `);
  return rows.rows.length > 0;
}

/** Goal 状态轻量投影(GET /api/goals/:id/status)。 */
export async function goalStatusView(db: RelayDb, goalId: string): Promise<GoalStatusView | null> {
  const goalRows = await db.execute(sql`
    SELECT id, raw_input, state FROM goals WHERE id = ${goalId}
  `);
  if (goalRows.rows.length === 0) return null;
  const g = goalRows.rows[0]!;
  const taskRows = await db.execute(sql`
    SELECT id, state, priority, updated_at FROM tasks
    WHERE goal_id = ${goalId}
    ORDER BY created_at ASC, id ASC
  `);
  const decRows = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM decisions
    WHERE goal_id = ${goalId} AND state = 'OPEN'
  `);
  const tasks = taskRows.rows.map((r) => ({
    id: str(r["id"]),
    state: str(r["state"]),
    priority: num(r["priority"]),
    updatedAt: iso(r["updated_at"]),
  }));
  const pendingDecisions = num(decRows.rows[0]?.["n"]);
  return {
    goalId: str(g["id"]),
    goalState: str(g["state"]),
    rawInput: str(g["raw_input"]),
    inFlight: tasks.some((t) => (IN_FLIGHT_STATES as readonly string[]).includes(t.state)),
    tasks,
    pendingDecisions,
  };
}

/**
 * Goal Feed 投影(GET /api/goals/:id/feed?after=<id>)。
 * messages:goal_messages 增量(游标 = bigserial id,单调);decisions:该 Goal 未决决策(全量快照,客户端整体替换);
 * status:轻量状态快照(同上)。合同 §6:Decision 直接进对话流;既有 resolve 端点语义不变。
 */
export async function goalFeedView(db: RelayDb, goalId: string, after: number | null): Promise<GoalFeedView | null> {
  const status = await goalStatusView(db, goalId);
  if (!status) return null;
  const limit = 200;
  const items: GoalFeedItem[] = after === null
    ? []
    : (await db.execute(sql`
        SELECT id, kind, actor, content, created_at FROM goal_messages
        WHERE goal_id = ${goalId} AND id > ${after}
        ORDER BY id ASC
        LIMIT ${limit + 1}
      `)).rows.map((r) => ({
        id: num(r["id"]),
        kind: str(r["kind"]),
        actor: str(r["actor"]),
        content: str(r["content"]),
        createdAt: iso(r["created_at"]),
      }));
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const decRows = await db.execute(sql`
    SELECT id, task_id, level, question, fallback, deadline, created_at FROM decisions
    WHERE goal_id = ${goalId} AND state = 'OPEN'
    ORDER BY created_at ASC
  `);
  const decisions = decRows.rows.map((r) => ({
    id: str(r["id"]),
    taskId: str(r["task_id"]),
    level: str(r["level"]),
    question: str(r["question"]),
    fallback: json<Record<string, unknown>>(r["fallback"], {}),
    deadline: r["deadline"] === null || r["deadline"] === undefined ? null : iso(r["deadline"]),
    createdAt: iso(r["created_at"]),
  }));
  return {
    goalId,
    cursor: after,
    nextCursor: page.length > 0 ? page[page.length - 1]!.id : after,
    hasMore,
    items: page,
    decisions,
    status,
  };
}

/** WEB-UX-03C §0.2:Task 关联的 follow-up 用户消息(经消费映射 goal_message_consumptions;Run 上下文注入用)。 */
export async function taskFollowUpMessagesView(
  db: RelayDb,
  taskId: string,
): Promise<Array<{ id: number; content: string }>> {
  const res = await db.execute(sql`
    SELECT gm.id AS id, gm.content AS content
    FROM goal_message_consumptions c
    JOIN goal_messages gm ON gm.id = c.message_id
    WHERE c.task_id = ${taskId} AND gm.actor = 'USER'
    ORDER BY gm.id ASC
  `);
  return res.rows.map((r) => ({ id: Number(r["id"]), content: String(r["content"]) }));
}
