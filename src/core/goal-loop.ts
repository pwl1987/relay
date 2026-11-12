// Goal Loop tick(P0-01C C-4;V11 退避/熔断、V15 IDLE、US-09 有界自治)。
// 设计:确定性单拍推进,复用 supervisorTick(回收→Reconcile→释放→领取);
// 本模块在其上叠加:
//   a) runTask 结果处置:失败 → 有界 REWORK+指数退避;相同失败签名连续 ≥K → 熔断 FAILED;
//      attempt 预算耗尽 → FAILED(ATTEMPT_BUDGET);
//   b) 预算触顶处置:RUNNER 返回 BUDGET_EXHAUSTED ⇒ 任务已被置 BLOCKED(见 runner),本层记录;
//   c) 模型断供探测(不烧 token 的回调)失败 ⇒ 本拍 IDLE,不领取不执行(V15);
//   d) IDLE:无可执行工作(无 READY/工作链/退避到期)⇒ 明确 IDLE 状态,由驱动方决定休眠;
//   e) goal 状态聚合:全部 task ACCEPTED ⇒ COMPLETED;全部终态且含失败 ⇒ FAILED。
// 状态事实全在 PostgreSQL;进程重启后 loop 从库恢复(无内存权威)。
// runTask 由调用方注入(组合 runner;core 不依赖 runtime,保持分层)。
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RelayDb, Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";
import { advanceTask, type AdvanceResult } from "./lease.ts";
import { supervisorTick, releaseRework, type TickReport } from "./supervisor.ts";
import { expireStaleDecisions } from "./decisions.ts";
import { setGoalState } from "./goals.ts";
import { consumeAllPendingGoals } from "./consumption.ts";
import { startSafeLoop, type SafeLoopHandle } from "./loop-safety.ts";
import { orchestrateGate, type GateOrchestrationOptions, type GateOrchestrationResult } from "./gate-orchestrator.ts";
import {
  proposeDelivery,
  executeDelivery,
  type DeliveryExecutionResult,
  type DeliveryIO,
  type ProposeDeliveryInput,
  type ProposeDeliveryResult,
} from "./delivery.ts";

export interface RunOutcomeDigest {
  outcome: string; // SUCCEEDED | FAILED | TIMEOUT | CANCELLED | INTERRUPTED | BUDGET_EXHAUSTED | ...
  reason?: string;
  taskId: string;
  /** Run 行 id(SUCCEEDED 时 Gate 编排需要,绑定 coder run) */
  runId?: string;
  /** Run 工作区宿主路径(SUCCEEDED 时证据检查 cwd 用) */
  workspaceDir?: string;
}

export interface GoalLoopTickOptions {
  actor?: string;
  workerId?: string;
  ttlSeconds?: number;
  executor?: NonNullable<Parameters<typeof supervisorTick>[1]>["executor"];
  /** 注入的实际 Run 执行(组合 runner;loop 不 import runtime)。返回后本层处置状态。 */
  runTask?: (claim: { taskId: string; ownerId: string; fencingToken: number; attempt: number }) => Promise<RunOutcomeDigest>;
  /** 模型断供探测(不烧 token;TCP/HEAD 级)。返回 false ⇒ 本拍 IDLE(不领取)。 */
  providerProbe?: () => Promise<boolean>;
  /** 相同失败签名熔断阈值(默认 3) */
  circuitThreshold?: number;
  /** 退避基数秒(默认 10;指数 2^(attempt-1),上限 300) */
  backoffBaseSeconds?: number;
  /** 无可执行工作时的休眠提示秒数(返回给驱动方) */
  idleSeconds?: number;
  /** Gate 编排(P0-02A):SUCCEEDED 后 验证租约→证据→独立 Reviewer→绑定版消费 */
  gate?: GateOrchestrationOptions;
  /** 交付(P0-02B):Gate ACCEPTED 后 Proposal→Policy→Intent→Scoped Executor→DELIVERED。
   * propose/execute 的 IO(executor/核验回调)由 runtime 注入,core 不做 git/网络 IO。 */
  delivery?: {
    propose: (input: { taskId: string; attempt: number }) => Promise<ProposeDeliveryInput>;
    io: (taskId: string) => Promise<DeliveryIO> | DeliveryIO;
  };
}

export interface GoalLoopTickReport {
  status: "PROGRESSED" | "IDLE" | "IDLE_PROVIDER_DOWN" | "PARTIAL";
  tick?: TickReport;
  run?: RunOutcomeDigest & { disposition?: string };
  gate?: GateOrchestrationResult;
  delivery?: { propose: { ok: boolean; reason?: string }; execute: DeliveryExecutionResult | { skipped: string } };
  /** WEB-UX-03C §0.1 安全边界消费(03B.1):本拍派生的 follow-up 消费结果(未消费时含 reason) */
  consumption?: { results: Array<{ consumed: boolean; reason?: string; taskId?: string }>; failedGoals: Array<{ goalId: string; error: string }> };
  goalStates?: Array<{ goalId: string; state: string }>;
  idleHintSeconds?: number;
}

function backoffSeconds(attempt: number, base: number): number {
  return Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), 300);
}

/** 相同失败签名连续次数(看最近 runs 的 detail->>'reason')。 */
async function failureStreak(exec: Exec, taskId: string): Promise<{ streak: number; signature: string | null }> {
  const res = await exec.execute(sql`
    SELECT COALESCE(detail->>'reason', outcome) AS sig
    FROM runs WHERE task_id = ${taskId} AND outcome IN ('FAILED','TIMEOUT','INTERRUPTED')
    ORDER BY started_at DESC LIMIT 10
  `);
  let streak = 0;
  let signature: string | null = null;
  for (const row of res.rows) {
    const sig = String(row["sig"]);
    if (signature === null) {
      signature = sig;
      streak = 1;
    } else if (sig === signature) {
      streak += 1;
    } else break;
  }
  return { streak, signature };
}

/**
 * Run 结果处置(a):调用方持有租约。
 * - SUCCEEDED:任务已由 runner 推进 VERIFYING,无动作;
 * - BUDGET_EXHAUSTED:任务已被 runner 置 BLOCKED,无动作(返回 disposition 供报告);
 * - 其他失败且任务 RUNNING(租约仍活):attempt 预算/熔断判定 → REWORK(退避)或 FAILED。
 */
export async function handleRunOutcome(
  db: RelayDb,
  claim: { taskId: string; ownerId: string; fencingToken: number; attempt: number },
  result: RunOutcomeDigest,
  opts: { circuitThreshold?: number; backoffBaseSeconds?: number; actor?: string } = {},
): Promise<{ disposition: string; detail?: AdvanceResult }> {
  const actor = opts.actor ?? "goal-loop";
  const circuitThreshold = opts.circuitThreshold ?? 3;
  const base = opts.backoffBaseSeconds ?? 10;
  if (result.outcome === "SUCCEEDED") return { disposition: "noop_succeeded" };
  if (result.outcome === "BUDGET_EXHAUSTED") return { disposition: "task_blocked_by_budget" };

  const stateRow = await db.execute(sql`SELECT state FROM tasks WHERE id = ${claim.taskId}`);
  const currentState = String(stateRow.rows[0]?.["state"] ?? "");
  if (currentState !== "RUNNING") {
    // 任务已离开 RUNNING(租约被回收/未推进):状态处置归 Supervisor reclaim 路径,本层不与其竞争
    return { disposition: `left_for_supervisor:${currentState}` };
  }
  const advance = (to: string) =>
    db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, claim.taskId, claim.ownerId, claim.fencingToken, "RUNNING", to),
    );

  const attemptRow = await db.execute(sql`SELECT attempt, max_attempts FROM tasks WHERE id = ${claim.taskId}`);
  const attempt = Number(attemptRow.rows[0]?.["attempt"] ?? claim.attempt);
  const maxAttempts = Number(attemptRow.rows[0]?.["max_attempts"] ?? 3);

  const { streak, signature } = await failureStreak(db, claim.taskId);
  if (signature && streak >= circuitThreshold) {
    const r = await advance("FAILED");
    await appendAudit(db as unknown as Exec, {
      actor,
      authority: "SUPERVISOR",
      action: "CIRCUIT_OPEN",
      taskId: claim.taskId,
      beforeState: "RUNNING",
      afterState: r.ok ? "FAILED" : "RUNNING",
      detail: { signature, streak, threshold: circuitThreshold, outcome: result.outcome },
    });
    return { disposition: "circuit_opened", detail: r };
  }
  if (attempt >= maxAttempts) {
    const r = await advance("FAILED");
    await appendAudit(db as unknown as Exec, {
      actor,
      authority: "SUPERVISOR",
      action: "ATTEMPT_BUDGET_EXHAUSTED",
      taskId: claim.taskId,
      beforeState: "RUNNING",
      afterState: r.ok ? "FAILED" : "RUNNING",
      detail: { attempt, maxAttempts, outcome: result.outcome },
    });
    return { disposition: "failed_attempt_budget", detail: r };
  }
  // 有界重试:RUNNING→REWORK→READY(+指数退避)
  const rework = await advance("REWORK");
  if (!rework.ok) return { disposition: `rework_rejected:${rework.reason}`, detail: rework };
  const backoff = backoffSeconds(attempt, base);
  await db.transaction(async (tx) => releaseRework(tx as unknown as Exec, actor, backoff));
  return { disposition: `retry_scheduled:${backoff}s` };
}

/** goal 状态聚合(确定性;只聚合,不改任务)。 */
async function aggregateGoals(exec: Exec): Promise<Array<{ goalId: string; state: string }>> {
  const active = await exec.execute(sql`
    SELECT id FROM goals WHERE state = 'ACTIVE' ORDER BY id
  `);
  const out: Array<{ goalId: string; state: string }> = [];
  for (const row of active.rows) {
    const goalId = String(row["id"]);
    const counts = await exec.execute(sql`
      SELECT
        count(*) FILTER (WHERE state = 'ACCEPTED') AS accepted,
        count(*) FILTER (WHERE state IN ('FAILED','CANCELLED')) AS failed,
        count(*) AS total
      FROM tasks WHERE goal_id = ${goalId}
    `);
    const c = counts.rows[0]!;
    const total = Number(c["total"]);
    const accepted = Number(c["accepted"]);
    const failed = Number(c["failed"]);
    if (total > 0 && accepted === total) {
      await setGoalState(exec, goalId, "COMPLETED", { accepted });
      out.push({ goalId, state: "COMPLETED" });
    } else if (total > 0 && accepted + failed === total) {
      await setGoalState(exec, goalId, "FAILED", { accepted, failed });
      out.push({ goalId, state: "FAILED" });
    }
  }
  return out;
}

/**
 * READY 任务的未决决策处置(领取前):
 * - D2:仅当存在事先授权 fallback ⇒ 自动按 fallback 裁决(RESOLVED_FALLBACK),任务保持 READY;
 * - D3:READY→NEEDS_DECISION(合法转移),移出候选池,等待人工;**永不自动批准**;
 *   其余任务不受影响(claim 按任务独立)。
 */
export async function handleOpenDecisions(db: RelayDb, actor = "goal-loop"): Promise<{ d2Resolved: number; d3Blocked: number }> {
  const rows = await db.execute(sql`
    SELECT d.id, d.level, d.task_id, d.fallback FROM decisions d
    JOIN tasks t ON t.id = d.task_id
    WHERE d.state = 'OPEN' AND t.state = 'READY'
    ORDER BY d.created_at
  `);
  let d2Resolved = 0;
  let d3Blocked = 0;
  for (const row of rows.rows) {
    const decisionId = String(row["id"]);
    const level = String(row["level"]);
    const taskId = String(row["task_id"]);
    const fallback = row["fallback"] as Record<string, unknown> | null;
    if (level === "D2") {
      if (!fallback) continue; // 无 fallback 的 D2 创建时已拒绝;防御性跳过
      await db.transaction(async (tx) => {
        await (tx as unknown as Exec).execute(sql`
          UPDATE decisions SET state = 'RESOLVED_FALLBACK',
            verdict = ${JSON.stringify({ action: "fallback", fallback })}::jsonb,
            decided_by = ${actor}, decided_at = now()
          WHERE id = ${decisionId} AND state = 'OPEN'
        `);
        await appendAudit(tx as unknown as Exec, {
          actor,
          authority: "SUPERVISOR",
          action: "DECISION_FALLBACK",
          taskId,
          detail: { decisionId, fallback, note: "D2 仅按事先授权的 fallback 执行(架构 §6)" },
        });
      });
      d2Resolved += 1;
    } else if (level === "D3") {
      // READY 任务未被领取(无租约):直接置 NEEDS_DECISION(合法转移)+ 审计
      await db.transaction(async (tx) => {
        await (tx as unknown as Exec).execute(sql`
          UPDATE tasks SET state = 'NEEDS_DECISION', state_version = state_version + 1, updated_at = now()
          WHERE id = ${taskId} AND state = 'READY'
        `);
        await appendAudit(tx as unknown as Exec, {
          actor,
          authority: "SUPERVISOR",
          action: "DECISION_BLOCK",
          taskId,
          beforeState: "READY",
          afterState: "NEEDS_DECISION",
          detail: { decisionId, note: "D3 需人批准;永不超时自动批准(T07)" },
        });
      });
      d3Blocked += 1;
    }
  }
  return { d2Resolved, d3Blocked };
}

/** 单拍推进(确定性;runTask/providerProbe 注入)。 */
export async function goalLoopTick(db: RelayDb, options: GoalLoopTickOptions = {}): Promise<GoalLoopTickReport> {
  const actor = options.actor ?? "goal-loop";
  const workerId = options.workerId ?? "worker-1";
  const ttl = options.ttlSeconds ?? 30;

  // c) 模型断供探测:失败 ⇒ IDLE(不领取、不执行、不烧 token)
  if (options.providerProbe) {
    const up = await options.providerProbe().catch(() => false);
    if (!up) {
      const pending = await pendingWork(db);
      return {
        status: "IDLE_PROVIDER_DOWN",
        idleHintSeconds: options.idleSeconds ?? 30,
        goalStates: [],
        ...(pending > 0 ? {} : {}),
      };
    }
  }

  // D3 超时标记(永不自动批准;仅标记 EXPIRED_STILL_BLOCKED)+ READY 任务决策处置
  await db.transaction(async (tx) => expireStaleDecisions(tx as unknown as Exec, actor));
  await handleOpenDecisions(db, actor);

  // WEB-UX-03C §0/§0.1(03B.1):安全边界消费——Run/Task 不在途时,把未处理 USER 消息
  // 合并派生为同 Goal follow-up Task(READY),本拍 supervisorTick 即可领取。
  // 在途 ⇒ 本步不动消息;Run 结束后的下一拍自动消费(at-most-once 由映射 UNIQUE 钉住)。
  let consumption: Awaited<ReturnType<typeof consumeAllPendingGoals>> | undefined;
  try {
    consumption = await consumeAllPendingGoals(db, actor);
  } catch {
    /* 消费扫描失败不阻断本拍推进;下一拍重试(映射 UNIQUE 保证不重复派生) */
  }

  const tick = await supervisorTick(db, {
    actor,
    workerId,
    ttlSeconds: ttl,
    ...(options.executor ? { executor: options.executor } : {}),
  });

  // a) 若本拍领到任务且注入了 runTask:执行并处置
  let run: GoalLoopTickReport["run"];
  let gateReport: GateOrchestrationResult | undefined;
  let deliveryReport: GoalLoopTickReport["delivery"];
  if (tick.claimed && options.runTask) {
    const claim = tick.claimed;
    const result = await options.runTask({
      taskId: claim.taskId,
      ownerId: claim.ownerId,
      fencingToken: claim.fencingToken,
      attempt: claim.attempt,
    });
    const disposition = await handleRunOutcome(
      db,
      { taskId: claim.taskId, ownerId: workerId, fencingToken: claim.fencingToken, attempt: claim.attempt },
      result,
      { circuitThreshold: options.circuitThreshold, backoffBaseSeconds: options.backoffBaseSeconds, actor },
    );
    run = { ...result, disposition: disposition.disposition };
    // a.5) Gate 编排(P0-02A):Run SUCCEEDED ⇒ 验证租约→证据→独立 Reviewer→绑定版消费。
    // 编排内部失败保持可恢复(验证租约到期被 reclaim ⇒ 新 attempt 重验;旧 PASS 绑定失配不可消费)。
    if (options.gate && result.outcome === "SUCCEEDED" && result.runId) {
      gateReport = await orchestrateGate(
        db,
        {
          taskId: claim.taskId,
          attempt: claim.attempt,
          coderRunId: result.runId,
          ...(result.workspaceDir ? { workspaceDir: result.workspaceDir } : {}),
          actor,
        },
        options.gate,
      );
      // a.6) 交付(P0-02B):Gate ACCEPTED ⇒ Proposal→Policy→Intent→Executor→DELIVERED。
      // 交付层任何失败不回滚质量结论(ACCEPTED 终态);CONFLICT/FAILED 落 D3 决策行(人工处置)。
      // P0-ACCEPT 缺口 A 收口:propose 装配阶段(候选未捕获/IO 异常)同样不冒泡——
      // 落 D3 + 审计(与 markConflict/markFailed 同语义),tick 其余结果照常返回。
      if (options.delivery && gateReport?.status === "ACCEPTED") {
        const deliveryActor = actor;
        try {
          const proposeInput = await options.delivery.propose({ taskId: claim.taskId, attempt: claim.attempt });
          const proposed = await db.transaction(async (tx) =>
            proposeDelivery(tx as unknown as Exec, proposeInput),
          );
          deliveryReport = {
            propose: proposed.ok ? { ok: true } : { ok: false, reason: proposed.reason },
            execute: proposed.ok
              ? await executeDelivery(db, await options.delivery.io(claim.taskId), proposed.proposal.id, { actor })
              : { skipped: `propose_rejected:${proposed.reason}` },
          };
        } catch (err) {
          const reason = `propose_failed:${(err as Error).message}`;
          deliveryReport = { propose: { ok: false, reason }, execute: { skipped: "propose_failed" } };
          await db
            .transaction(async (tx) => {
              const e = tx as unknown as Exec;
              const goalRow = await e.execute(sql`SELECT goal_id FROM tasks WHERE id = ${claim.taskId}`);
              const gid = goalRow.rows[0]?.["goal_id"];
              const goalId = gid === null || gid === undefined ? null : String(gid);
              await e.execute(sql`
                INSERT INTO decisions (id, task_id, goal_id, level, question, state)
                VALUES (${`dec-dl-${randomUUID()}`}, ${claim.taskId}, ${goalId}, 'D3',
                  ${`delivery_propose_failed(交付装配失败;人工处置,永不自动批准):${reason}`}, 'OPEN')
              `);
              await appendAudit(e, {
                actor: deliveryActor,
                authority: "WORKER",
                action: "DELIVERY_PROPOSE_FAILED",
                taskId: claim.taskId,
                detail: { reason, note: "交付装配失败不回滚 Gate 结论(ACCEPTED 终态);D3 人工处置" },
              });
            })
            .catch(() => {
              /* 落记尽力而为;tick 报告已如实携带 propose 失败 */
            });
        }
      }
    }
  }

  const goalStates = await db.transaction(async (tx) => aggregateGoals(tx as unknown as Exec));
  const pending = await pendingWork(db);
  const status: GoalLoopTickReport["status"] = run
    ? "PROGRESSED"
    : tick.claimed
      ? "PROGRESSED"
      : pending > 0
        ? "PARTIAL"
        : "IDLE";
  return {
    status,
    tick,
    run,
    ...(gateReport ? { gate: gateReport } : {}),
    ...(deliveryReport ? { delivery: deliveryReport } : {}),
    ...(consumption ? { consumption } : {}),
    goalStates,
    ...(status === "IDLE" ? { idleHintSeconds: options.idleSeconds ?? 30 } : {}),
  };
}

/** 待办工作计数(READY 含退避到期 / 工作链 / 需恢复态)。 */
export async function pendingWork(db: RelayDb): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS n FROM tasks
    WHERE state IN ('READY','LEASED','RUNNING','SUBMITTED','VERIFYING','REWORK','NEEDS_RECONCILE')
      AND (state <> 'READY' OR retry_not_before IS NULL OR retry_not_before <= now())
  `);
  return Number(res.rows[0]?.["n"] ?? 0);
}

/** 持续驱动(进程重启后从 PG 恢复事实状态;无内存权威)。
 *  P0-02A C-7:tick 异常可观测/熔断(连续 ≥ 阈值停调度),不再静默吞异常(P0-01C F-8 收口)。 */
export function startGoalLoop(
  db: RelayDb,
  options: GoalLoopTickOptions & {
    intervalMs: number;
    errorThreshold?: number;
    onTickError?: (error: Error, consecutiveErrors: number) => void;
    onCircuitOpen?: (error: Error, consecutiveErrors: number) => void;
  },
): SafeLoopHandle {
  const { intervalMs, errorThreshold, onTickError, onCircuitOpen, ...tickOptions } = options;
  return startSafeLoop(() => goalLoopTick(db, tickOptions), {
    intervalMs,
    ...(errorThreshold !== undefined ? { errorThreshold } : {}),
    ...(onTickError ? { onTickError } : {}),
    ...(onCircuitOpen ? { onCircuitOpen } : {}),
    auditTickError: (e, streak) =>
      appendAudit(db as unknown as Exec, {
        actor: "goal-loop",
        authority: "SUPERVISOR",
        action: "TICK_ERROR",
        detail: { error: e.message, consecutiveErrors: streak, loop: "goal" },
      }),
  });
}
