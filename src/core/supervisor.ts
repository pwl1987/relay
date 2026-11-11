// Supervisor Tick:确定性的单步推进函数(可被循环驱动,也可被测试逐拍调用)。
// 顺序:回收过期租约 -> Reconcile 意图未明的任务 -> 释放 REWORK -> 领取下一个 READY。
// Supervisor 不做窗口内强收(TTL=权威窗口);只在租约过期后回收且必留审计。
import { sql } from "drizzle-orm";
import type { RelayDb, Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";
import { claimTask, type ClaimResult } from "./lease.ts";
import { startSafeLoop, type SafeLoopHandle } from "./loop-safety.ts";
import { reconcileIntent, type IntentExecutor, type ReconcileDecision } from "./intents.ts";

export interface ReclaimedTask {
  taskId: string;
  fromState: string;
  ownerId: string;
  fencingToken: number;
}

// a) 回收:工作链状态 + 租约已过期 ⇒ NEEDS_RECONCILE(先落审计;意图未明的任务随后由 b 步核对真实状态)。
export async function reclaimExpiredLeases(
  exec: Exec,
  actor = "supervisor",
): Promise<ReclaimedTask[]> {
  const rows = await exec.execute(sql`
    SELECT t.id AS task_id, t.state, l.owner_id, l.fencing_token
    FROM tasks t JOIN leases l ON l.task_id = t.id
    WHERE l.lease_expires_at <= now()
      AND t.state IN ('LEASED','RUNNING','SUBMITTED','VERIFYING')
    ORDER BY t.id
    FOR UPDATE OF t SKIP LOCKED
  `);
  const reclaimed: ReclaimedTask[] = [];
  for (const row of rows.rows) {
    const taskId = String(row["task_id"]);
    const fromState = String(row["state"]);
    const ownerId = String(row["owner_id"]);
    const fencingToken = Number(row["fencing_token"]);
    await exec.execute(sql`
      UPDATE tasks SET state = 'NEEDS_RECONCILE',
        state_version = state_version + 1, updated_at = now()
      WHERE id = ${taskId}
    `);
    await appendAudit(exec, {
      actor,
      authority: "SUPERVISOR",
      action: "RECLAIM_EXPIRED",
      taskId,
      beforeState: fromState,
      afterState: "NEEDS_RECONCILE",
      detail: { reason: "lease_expired", previousOwner: ownerId, fencingToken },
    });
    reclaimed.push({ taskId, fromState, ownerId, fencingToken });
  }
  return reclaimed;
}

// b) NEEDS_RECONCILE 任务:先 Reconcile EXECUTING 意图(查目标真实状态),
//    无 REMOTE_MOVED ⇒ READY;有 ⇒ 已由 reconcileIntent 置 BLOCKED。
export interface ReconciledTask {
  taskId: string;
  decisions: Array<{ intentId: string; decision: ReconcileDecision | "already_completed" }>;
  toState: "READY" | "BLOCKED";
}

export async function reconcilePendingTasks(
  db: RelayDb,
  executor: IntentExecutor,
  actor = "supervisor",
): Promise<ReconciledTask[]> {
  const pending = await db.execute(sql`
    SELECT DISTINCT t.id AS task_id FROM tasks t
    JOIN action_intents i ON i.task_id = t.id
    WHERE t.state = 'NEEDS_RECONCILE' AND i.state = 'EXECUTING'
    ORDER BY t.id
  `);
  const results: ReconciledTask[] = [];
  for (const row of pending.rows) {
    const taskId = String(row["task_id"]);
    const intents = await db.execute(sql`
      SELECT id FROM action_intents WHERE task_id = ${taskId} AND state = 'EXECUTING' ORDER BY id
    `);
    const decisions: ReconciledTask["decisions"] = [];
    for (const irow of intents.rows) {
      const intentId = String(irow["id"]);
      const r = await db.transaction(async (tx) =>
        reconcileIntent(tx as unknown as Exec, executor, intentId, { actor }),
      );
      decisions.push({ intentId, decision: r.decision });
    }
    const needsHuman = decisions.some((d) => d.decision === "REMOTE_MOVED_NEEDS_HUMAN");
    if (!needsHuman) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE tasks SET state = 'READY', blocked_reason = NULL,
            state_version = state_version + 1, updated_at = now()
          WHERE id = ${taskId} AND state = 'NEEDS_RECONCILE'
        `);
        await appendAudit(tx as unknown as Exec, {
          actor,
          authority: "RECONCILER",
          action: "RECONCILE_READY",
          taskId,
          beforeState: "NEEDS_RECONCILE",
          afterState: "READY",
          detail: { decisions },
        });
      });
    }
    results.push({ taskId, decisions, toState: needsHuman ? "BLOCKED" : "READY" });
  }

  // 无 EXECUTING 意图的 NEEDS_RECONCILE(崩溃发生在外部动作之前)⇒ 直接 READY
  const noPending = await db.execute(sql`
    SELECT t.id AS task_id FROM tasks t
    WHERE t.state = 'NEEDS_RECONCILE'
      AND NOT EXISTS (
        SELECT 1 FROM action_intents i WHERE i.task_id = t.id AND i.state = 'EXECUTING'
      )
    ORDER BY t.id
  `);
  for (const row of noPending.rows) {
    const taskId = String(row["task_id"]);
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE tasks SET state = 'READY', blocked_reason = NULL,
          state_version = state_version + 1, updated_at = now()
        WHERE id = ${taskId} AND state = 'NEEDS_RECONCILE'
      `);
      await appendAudit(tx as unknown as Exec, {
        actor,
        authority: "RECONCILER",
        action: "RECONCILE_READY",
        taskId,
        beforeState: "NEEDS_RECONCILE",
        afterState: "READY",
        detail: { reason: "no_pending_executing_intents" },
      });
    });
    results.push({ taskId, decisions: [], toState: "READY" });
  }
  return results;
}

// c) REWORK ⇒ READY(新 attempt 由下次 claim 计数;审计留痕)。
// backoffSeconds:REWORK→READY 时设置退避(此前不进候选);缺省清零(保持旧行为)。
export async function releaseRework(exec: Exec, actor = "supervisor", backoffSeconds?: number): Promise<string[]> {
  const rows = await exec.execute(sql`
    SELECT id FROM tasks WHERE state = 'REWORK' ORDER BY id FOR UPDATE SKIP LOCKED
  `);
  const released: string[] = [];
  for (const row of rows.rows) {
    const taskId = String(row["id"]);
    await exec.execute(sql`
      UPDATE tasks SET state = 'READY', state_version = state_version + 1,
        retry_not_before = ${backoffSeconds !== undefined ? sql`now() + make_interval(secs => ${backoffSeconds})` : sql`NULL`},
        updated_at = now()
      WHERE id = ${taskId}
    `);
    await appendAudit(exec, {
      actor,
      authority: "SUPERVISOR",
      action: "RETRY_READY",
      taskId,
      beforeState: "REWORK",
      afterState: "READY",
      detail: { reason: "rework_released" },
    });
    released.push(taskId);
  }
  return released;
}

// d) 领取:READY 按 priority DESC, created_at ASC;预算耗尽者拒绝(留审计)后尝试下一个。
export async function claimNextReady(
  exec: Exec,
  ownerId: string,
  ttlSeconds: number,
): Promise<Extract<ClaimResult, { ok: true }> | { ok: false; reason: string }> {
  const candidates = await exec.execute(sql`
    SELECT id FROM tasks WHERE state = 'READY'
      AND (retry_not_before IS NULL OR retry_not_before <= now())
    ORDER BY priority DESC, created_at ASC, id ASC
    FOR UPDATE SKIP LOCKED
  `);
  for (const row of candidates.rows) {
    const taskId = String(row["id"]);
    const r = await claimTask(exec, taskId, ownerId, ttlSeconds);
    if (r.ok) return r;
  }
  return { ok: false, reason: candidates.rows.length === 0 ? "no_ready_tasks" : "all_candidates_rejected" };
}

export interface TickOptions {
  actor?: string;
  workerId?: string;
  ttlSeconds?: number;
  /**
   * 是否领取 READY 任务(缺省 true 兼容既有语义)。
   * E1 worker-entry 组合:Supervisor 无执行器,置 false(领取交给 goal 环路的 live driver;
   * 否则两环路争抢 ⇒ 任务被领走后无人执行,白等租约过期)。
   */
  claim?: boolean;
  /** 提供 executor 时,本拍会对 NEEDS_RECONCILE 任务执行 Reconcile */
  executor?: IntentExecutor;
}

export interface TickReport {
  reclaimed: ReclaimedTask[];
  reconciled: ReconciledTask[];
  reworkReleased: string[];
  claimed: { taskId: string; ownerId: string; fencingToken: number; attempt: number } | null;
}

// 单拍推进。每步独立事务:外部 Reconcile 调用不与行锁长事务交叉。
export async function supervisorTick(db: RelayDb, options: TickOptions = {}): Promise<TickReport> {
  const actor = options.actor ?? "supervisor";
  const reclaimed = await db.transaction(async (tx) =>
    reclaimExpiredLeases(tx as unknown as Exec, actor),
  );
  const reconciled = options.executor
    ? await reconcilePendingTasks(db, options.executor, actor)
    : [];
  const reworkReleased = await db.transaction(async (tx) => releaseRework(tx as unknown as Exec, actor));
  const claim = options.claim === false
    ? null
    : await db.transaction(async (tx) =>
        claimNextReady(tx as unknown as Exec, options.workerId ?? "worker-1", options.ttlSeconds ?? 30),
      );
  return {
    reclaimed,
    reconciled,
    reworkReleased,
    claimed: claim && claim.ok
      ? {
          taskId: claim.taskId,
          ownerId: claim.ownerId,
          fencingToken: claim.fencingToken,
          attempt: claim.attempt,
        }
      : null,
  };
}

// 持续驱动循环(生产形态;测试用 supervisorTick 逐拍驱动以保持确定性)。
// P0-02A C-7:异常可观测/熔断(连续 ≥ 阈值停调度;回调 + 尽力审计),不再静默吞异常。
export function startSupervisorLoop(
  db: RelayDb,
  options: TickOptions & {
    intervalMs: number;
    errorThreshold?: number;
    onTickError?: (error: Error, consecutiveErrors: number) => void;
    onCircuitOpen?: (error: Error, consecutiveErrors: number) => void;
  },
): SafeLoopHandle {
  const { intervalMs, errorThreshold, onTickError, onCircuitOpen, ...tickOptions } = options;
  return startSafeLoop(() => supervisorTick(db, tickOptions), {
    intervalMs,
    ...(errorThreshold !== undefined ? { errorThreshold } : {}),
    ...(onTickError ? { onTickError } : {}),
    ...(onCircuitOpen ? { onCircuitOpen } : {}),
    auditTickError: (e, streak) =>
      appendAudit(db as unknown as Exec, {
        actor: "supervisor-loop",
        authority: "SUPERVISOR",
        action: "TICK_ERROR",
        detail: { error: e.message, consecutiveErrors: streak, loop: "supervisor" },
      }),
  });
}
