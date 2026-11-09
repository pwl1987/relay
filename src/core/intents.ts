// 外部副作用两阶段意图日志 + Reconcile(架构 §4;p0-00 exp-c 实测语义的正式化)。
//
// 生命周期:RESERVED -> EXECUTING -> COMPLETED | CONFLICT | FAILED
// - 执行前必须核对目标真实状态与 expected 匹配(远端漂移 ⇒ CONFLICT,绝不强推)。
// - 外部动作本身在 DB 事务之外执行(原子承诺仅在 DB 内部事务有效);
//   "副作用已发生、回执未写"的窗口由 Reconcile 兜底。
// - Reconcile 先查询目标真实状态再决策,绝不盲目重放(NFR-06):
//     SIDE_EFFECT_CONFIRMED            副作用已在目标上生效 ⇒ COMPLETED,不重做
//     SIDE_EFFECT_ABSENT_REEXECUTE_SAFE 目标仍是 expected ⇒ 未发生,可安全重试
//     REMOTE_MOVED_NEEDS_HUMAN          目标已漂移 ⇒ CONFLICT + 任务 BLOCKED,人工处理
import { sql } from "drizzle-orm";
import type { Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";

export type IntentState = "RESERVED" | "EXECUTING" | "COMPLETED" | "CONFLICT" | "FAILED";

export type ReconcileDecision =
  | "SIDE_EFFECT_CONFIRMED"
  | "SIDE_EFFECT_ABSENT_REEXECUTE_SAFE"
  | "REMOTE_MOVED_NEEDS_HUMAN";

// 执行器端口:check 读取目标真实状态;perform 执行外部副作用(结果未知语义)。
// 允许动作成功,禁止动作拒绝(Policy)由调用方在 reserve/execute 前裁决。
export interface IntentExecutor {
  /** 目标当前真实头 SHA;目标不存在时返回 "" */
  check(intent: IntentRef): Promise<string>;
  /** 执行外部副作用。抛错 = 明确失败且无副作用假设(调用方按 FAILED 处理) */
  perform(intent: IntentRef): Promise<void>;
}

export interface IntentRef {
  id: string;
  taskId: string | null;
  capability: string;
  target: string;
  branch: string | null;
  expectedRemoteSha: string | null;
  payloadSha: string | null;
}

// 原始行(snake_case,来自裸 SQL execute)
interface IntentRow {
  id: string;
  task_id: string | null;
  idempotency_key: string;
  capability: string;
  target: string;
  branch: string | null;
  expected_remote_sha: string | null;
  payload_sha: string | null;
  state: IntentState;
}

export interface ReserveIntentSpec {
  id?: string;
  taskId: string;
  idempotencyKey: string;
  capability: string;
  target: string;
  branch?: string | null;
  expectedRemoteSha?: string | null;
  payloadSha?: string | null;
  deadline?: Date | null;
}

async function rowToRef(row: IntentRow): Promise<IntentRef> {
  return {
    id: row.id,
    taskId: row.task_id ?? null,
    capability: row.capability,
    target: row.target,
    branch: row.branch ?? null,
    expectedRemoteSha: row.expected_remote_sha ?? null,
    payloadSha: row.payload_sha ?? null,
  };
}

// 阶段 1:预留意图(idempotency_key 幂等;同 key 重复预留不产生第二行)。
export async function reserveIntent(
  exec: Exec,
  spec: ReserveIntentSpec,
): Promise<{ id: string; created: boolean }> {
  const id = spec.id ?? `intent-${spec.idempotencyKey}`;
  const res = await exec.execute(sql`
    INSERT INTO action_intents
      (id, task_id, idempotency_key, capability, target, branch,
       expected_remote_sha, payload_sha, state, deadline)
    VALUES (${id}, ${spec.taskId}, ${spec.idempotencyKey}, ${spec.capability}, ${spec.target},
       ${spec.branch ?? null}, ${spec.expectedRemoteSha ?? null}, ${spec.payloadSha ?? null},
       'RESERVED', ${spec.deadline ?? null})
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `);
  const created = res.rows.length > 0;
  const finalId = created ? String(res.rows[0]!["id"]) : id;
  await appendAudit(exec, {
    actor: "worker",
    authority: "WORKER",
    action: "INTENT_RESERVED",
    taskId: spec.taskId,
    intentId: finalId,
    detail: {
      idempotencyKey: spec.idempotencyKey,
      capability: spec.capability,
      target: spec.target,
      branch: spec.branch ?? null,
      expectedRemoteSha: spec.expectedRemoteSha ?? null,
      payloadSha: spec.payloadSha ?? null,
      created,
    },
  });
  return { id: finalId, created };
}

export interface ExecuteOptions {
  /** 故障注入钩子(非生产):外部动作前的受控停顿,默认 0 */
  preActionPauseMs?: number;
  /** "副作用已发生、回执未写"窗口模拟(测试用),默认 0 */
  postActionPauseMs?: number;
  actor?: string;
}

export type ExecuteResult =
  | { ok: true; state: "COMPLETED" }
  | { ok: false; state: IntentState; reason: string; actual?: string };

// 阶段 2:执行。前置核对(expected 不匹配 ⇒ CONFLICT,拒绝无强推)。
// 执行路径:tx1(标 EXECUTING) -> 外部动作 -> tx2(标 COMPLETED)。
export async function executeIntent(
  exec: Exec,
  executor: IntentExecutor,
  intentId: string,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const actor = options.actor ?? "executor";
  const rows = await exec.execute(sql`SELECT * FROM action_intents WHERE id = ${intentId} FOR UPDATE`);
  const intent = rows.rows[0] as IntentRow | undefined;
  if (!intent) throw new Error(`intent not found: ${intentId}`);
  const ref = await rowToRef(intent);

  if (intent.state === "COMPLETED") {
    return { ok: true, state: "COMPLETED" };
  }
  if (intent.state === "EXECUTING") {
    return { ok: false, state: "EXECUTING", reason: "already_executing_reconcile_first" };
  }
  if (intent.state === "CONFLICT") {
    return { ok: false, state: "CONFLICT", reason: "conflicted_needs_human" };
  }

  // 前置核对:目标真实状态必须等于执行前预期
  const actual = await executor.check(ref);
  if (ref.expectedRemoteSha !== null && actual !== ref.expectedRemoteSha) {
    await exec.execute(sql`
      UPDATE action_intents SET state = 'CONFLICT', updated_at = now() WHERE id = ${intentId}
    `);
    await appendAudit(exec, {
      actor,
      authority: "WORKER",
      action: "EXECUTE_CONFLICT",
      taskId: ref.taskId,
      intentId,
      detail: {
        expected: ref.expectedRemoteSha,
        actual,
        decision: "REJECT_NO_FORCE_PUSH",
      },
    });
    return { ok: false, state: "CONFLICT", reason: "remote_drift", actual };
  }

  await exec.execute(sql`
    UPDATE action_intents SET state = 'EXECUTING', updated_at = now() WHERE id = ${intentId}
  `);
  await appendAudit(exec, {
    actor,
    authority: "WORKER",
    action: "EXECUTE_START",
    taskId: ref.taskId,
    intentId,
    detail: { capability: ref.capability, target: ref.target },
  });

  if (options.preActionPauseMs && options.preActionPauseMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.preActionPauseMs));
  }

  try {
    await executor.perform(ref);
  } catch (err) {
    // 明确失败且假设无副作用:标记 FAILED(可按预算重试,重试前仍会前置核对)
    await exec.execute(sql`
      UPDATE action_intents SET state = 'FAILED', updated_at = now() WHERE id = ${intentId}
    `);
    await appendAudit(exec, {
      actor,
      authority: "WORKER",
      action: "EXECUTE_FAILED",
      taskId: ref.taskId,
      intentId,
      detail: { error: String(err) },
    });
    return { ok: false, state: "FAILED", reason: "perform_failed" };
  }

  // —— 外部副作用已发生;以下"回执"尚未写 ——(丢失回执窗口由 Reconcile 兜底)
  if (options.postActionPauseMs && options.postActionPauseMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.postActionPauseMs));
  }

  await exec.execute(sql`
    UPDATE action_intents SET state = 'COMPLETED', updated_at = now() WHERE id = ${intentId}
  `);
  await appendAudit(exec, {
    actor,
    authority: "WORKER",
    action: "EXECUTE_COMPLETED",
    taskId: ref.taskId,
    intentId,
  });
  return { ok: true, state: "COMPLETED" };
}

export interface ReconcileResult {
  decision: ReconcileDecision | "already_completed";
  actualRemoteHead?: string;
}

// 阶段 3:恢复。结果未知时必须先查询目标真实状态,再决策;绝不盲目重放。
export async function reconcileIntent(
  exec: Exec,
  executor: IntentExecutor,
  intentId: string,
  options: { actor?: string } = {},
): Promise<ReconcileResult> {
  const actor = options.actor ?? "reconciler";
  const rows = await exec.execute(sql`SELECT * FROM action_intents WHERE id = ${intentId} FOR UPDATE`);
  const intent = rows.rows[0] as IntentRow | undefined;
  if (!intent) throw new Error(`intent not found: ${intentId}`);
  const ref = await rowToRef(intent);

  if (intent.state === "COMPLETED") {
    await appendAudit(exec, {
      actor,
      authority: "RECONCILER",
      action: "RECONCILE",
      taskId: ref.taskId,
      intentId,
      detail: { decision: "already_completed", intentState: intent.state },
    });
    return { decision: "already_completed" };
  }

  const actual = await executor.check(ref);
  let decision: ReconcileDecision;
  if (ref.payloadSha !== null && actual === ref.payloadSha) {
    decision = "SIDE_EFFECT_CONFIRMED";
    await exec.execute(sql`
      UPDATE action_intents SET state = 'COMPLETED', updated_at = now() WHERE id = ${intentId}
    `);
  } else if (isAbsent(actual, ref.expectedRemoteSha)) {
    decision = "SIDE_EFFECT_ABSENT_REEXECUTE_SAFE";
    await exec.execute(sql`
      UPDATE action_intents SET state = 'RESERVED', updated_at = now() WHERE id = ${intentId}
    `);
  } else {
    decision = "REMOTE_MOVED_NEEDS_HUMAN";
    await exec.execute(sql`
      UPDATE action_intents SET state = 'CONFLICT', updated_at = now() WHERE id = ${intentId}
    `);
    if (ref.taskId !== null) {
      await exec.execute(sql`
        UPDATE tasks SET state = 'BLOCKED', blocked_reason = 'remote_moved_needs_human',
          state_version = state_version + 1, updated_at = now()
        WHERE id = ${ref.taskId} AND state IN ('NEEDS_RECONCILE','RUNNING','LEASED','READY')
      `);
    }
  }

  await appendAudit(exec, {
    actor,
    authority: "RECONCILER",
    action: "RECONCILE",
    taskId: ref.taskId,
    intentId,
    beforeState: intent.state,
    afterState: decision === "SIDE_EFFECT_CONFIRMED" ? "COMPLETED" : decision === "REMOTE_MOVED_NEEDS_HUMAN" ? "CONFLICT" : "RESERVED",
    detail: {
      decision,
      intentState: intent.state,
      actualRemoteHead: actual,
      payloadSha: ref.payloadSha,
      expectedSha: ref.expectedRemoteSha,
    },
  });
  return { decision, actualRemoteHead: actual };
}

// 目标仍处于执行前预期 ⇒ 副作用未发生。
function isAbsent(actual: string, expected: string | null): boolean {
  if (expected === null) return actual === "" || actual === "null" ? true : actual === expected;
  return actual === expected;
}
