// 只读视图·Dashboard(WEB-UX-01 §4.3 自 src/server/views.ts 拆分;行为不变;只含 SELECT)。
import { sql } from "drizzle-orm";
import type { RelayDb } from "../../core/db.ts";
import { iso, num, str, json, type Row, type TaskStateCounts, IN_FLIGHT_STATES } from "./shared.ts";

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
