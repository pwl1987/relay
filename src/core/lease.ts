// 核心租约/状态推进(ADR-0007 裁决语义;p0-00 exp-b 实测语义的正式化)。
//
// 不变式:
// - 每个函数都在单个事务内完成:行锁 -> 校验(租约/fencing/期望状态/转移表/Gate) -> 变更 + 审计 -> 提交。
// - fencing_token 单调递增,依赖 leases 历史行(永不删除)。
// - 拒绝同样落审计(append-only),拒绝路径不修改任务状态。
// - TTL 窗口 = 权威窗口:窗口内旧 Token 即使持有进程已死仍具权威(B3b 实测);
//   因此 Worker 有心跳续租义务,Supervisor 只在过期后回收(见 supervisor.ts)。
// - 时间权威在数据库(now()),不信任应用时钟。
import { sql } from "drizzle-orm";
import type { Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";
import { isGatedTransition, isLegalTransition, inLeasedChain, isTerminal, leaseReleasedOn } from "./lifecycle.ts";

export interface ClaimOk {
  ok: true;
  taskId: string;
  ownerId: string;
  fencingToken: number;
  attempt: number;
  reclaimedExpired: boolean;
}
export interface ClaimRejected {
  ok: false;
  taskId: string;
  ownerId: string;
  reason: string;
}
export type ClaimResult = ClaimOk | ClaimRejected;

export interface AdvanceOk {
  ok: true;
  taskId: string;
  state: string;
  stateVersion: number;
  leaseReleased: boolean;
}
export interface AdvanceRejected {
  ok: false;
  taskId: string;
  ownerId: string;
  reason: string;
  state: string;
}
export type AdvanceResult = AdvanceOk | AdvanceRejected;

export interface HeartbeatResult {
  ok: boolean;
  reason?: string;
  leaseExpiresAt?: string;
}

interface TaskRow {
  id: string;
  state: string;
  state_version: number;
  attempt: number;
  max_attempts: number;
  gate_required: boolean;
}

interface LeaseRow {
  task_id: string;
  owner_id: string;
  fencing_token: string | number;
  lease_expires_at: string | Date;
  live: boolean;
}

async function lockTask(exec: Exec, taskId: string): Promise<TaskRow> {
  const res = await exec.execute(sql`SELECT * FROM tasks WHERE id = ${taskId} FOR UPDATE`);
  const row = res.rows[0] as TaskRow | undefined;
  if (!row) throw new Error(`task not found: ${taskId}`);
  return row;
}

async function lockLease(exec: Exec, taskId: string): Promise<LeaseRow | null> {
  const res = await exec.execute(sql`
    SELECT *, (lease_expires_at > now()) AS live
    FROM leases WHERE task_id = ${taskId} FOR UPDATE
  `);
  return (res.rows[0] as LeaseRow | undefined) ?? null;
}

async function countExecutingIntents(exec: Exec, taskId: string): Promise<number> {
  const res = await exec.execute(sql`
    SELECT count(*)::int AS n FROM action_intents
    WHERE task_id = ${taskId} AND state = 'EXECUTING'
  `);
  return Number(res.rows[0]?.["n"] ?? 0);
}

async function countGatePass(exec: Exec, taskId: string): Promise<number> {
  const res = await exec.execute(sql`
    SELECT count(*)::int AS n FROM task_gate_verdicts
    WHERE task_id = ${taskId} AND verdict = 'PASS'
  `);
  return Number(res.rows[0]?.["n"] ?? 0);
}

// 领取租约(必须处于事务内)。READY 可领;工作链状态且租约已过期可回收领取;
// 存在 EXECUTING 意图的任务必须先 Reconcile(不得盲目重做外部副作用);
// attempt >= max_attempts 时拒绝(NFR-05 预算)。
export async function claimTask(
  exec: Exec,
  taskId: string,
  ownerId: string,
  ttlSeconds: number,
): Promise<ClaimResult> {
  const task = await lockTask(exec, taskId);
  const lease = await lockLease(exec, taskId);

  if (isTerminal(task.state)) {
    return rejectClaim(exec, task.id, ownerId, `state_terminal:${task.state}`);
  }
  if (task.state === "READY" && task.attempt >= task.max_attempts) {
    return rejectClaim(exec, task.id, ownerId, "attempt_budget_exhausted");
  }
  const executing = await countExecutingIntents(exec, taskId);
  if (executing > 0) {
    return rejectClaim(exec, task.id, ownerId, "executing_intents_need_reconcile");
  }
  const leaseLive = lease !== null && lease.live;
  const claimable =
    task.state === "READY" || (inLeasedChain(task.state) && !leaseLive);
  if (!claimable) {
    return rejectClaim(exec, task.id, ownerId, `state_not_claimable:${task.state}`);
  }
  const reclaimedExpired = inLeasedChain(task.state) && !leaseLive;
  const fencing = lease ? Number(lease.fencing_token) + 1 : 1;

  await exec.execute(sql`
    INSERT INTO leases (task_id, owner_id, fencing_token, lease_expires_at, heartbeat_at)
    VALUES (${taskId}, ${ownerId}, ${fencing}, now() + make_interval(secs => ${ttlSeconds}), now())
    ON CONFLICT (task_id) DO UPDATE SET
      owner_id = ${ownerId},
      fencing_token = ${fencing},
      lease_expires_at = now() + make_interval(secs => ${ttlSeconds}),
      heartbeat_at = now()
  `);
  await exec.execute(sql`
    UPDATE tasks SET state = 'LEASED', state_version = state_version + 1,
      attempt = attempt + 1, blocked_reason = NULL, updated_at = now()
    WHERE id = ${taskId}
  `);
  await appendAudit(exec, {
    actor: ownerId,
    authority: "WORKER",
    action: "CLAIM",
    taskId,
    beforeState: task.state,
    afterState: "LEASED",
    detail: { fencing, ttlSeconds, reclaimedExpired },
  });
  return { ok: true, taskId, ownerId, fencingToken: fencing, attempt: task.attempt + 1, reclaimedExpired };
}

async function rejectClaim(exec: Exec, taskId: string, ownerId: string, reason: string): Promise<ClaimRejected> {
  await appendAudit(exec, {
    actor: ownerId,
    authority: "WORKER",
    action: "CLAIM_REJECTED",
    taskId,
    detail: { reason },
  });
  return { ok: false, taskId, ownerId, reason };
}

// 推进状态(必须处于事务内):有效租约 + fencing 匹配 + from 匹配 + 合法转移(+ Gate PASS)。
export async function advanceTask(
  exec: Exec,
  taskId: string,
  ownerId: string,
  fencingToken: number,
  fromState: string,
  toState: string,
): Promise<AdvanceResult> {
  const task = await lockTask(exec, taskId);
  const lease = await lockLease(exec, taskId);

  const fail = async (reason: string): Promise<AdvanceResult> => {
    await appendAudit(exec, {
      actor: ownerId,
      authority: "WORKER",
      action: "ADVANCE_REJECTED",
      taskId,
      beforeState: task.state,
      afterState: task.state,
      detail: { reason, fencingToken, fromState, toState },
    });
    return { ok: false, taskId, ownerId, reason, state: task.state };
  };

  // 终态绝对优先:无论租约状态,终态任务不可推进(双接受/终态复活均不可能)
  if (isTerminal(task.state)) return fail(`state_terminal:${task.state}`);
  if (!lease) return fail("no_lease");
  // fencing 先于 owner 校验:对过期持有者不泄漏当前 owner,且 fencing 是主防线(B3 语义)
  if (Number(lease.fencing_token) !== fencingToken) return fail(`fenced:token=${lease.fencing_token}`);
  if (lease.owner_id !== ownerId) return fail(`lease_owner_mismatch:${lease.owner_id}`);
  if (!lease.live) return fail("lease_expired");
  if (task.state !== fromState) return fail(`state_mismatch:${task.state}`);
  if (!isLegalTransition(fromState, toState)) return fail(`illegal_transition:${fromState}->${toState}`);
  if (isGatedTransition(fromState, toState) && task.gate_required) {
    const passes = await countGatePass(exec, taskId);
    if (passes === 0) return fail("gate_not_passed");
  }

  const release = leaseReleasedOn(toState);
  await exec.execute(sql`
    UPDATE tasks SET state = ${toState}, state_version = state_version + 1,
      blocked_reason = ${toState === "BLOCKED" ? "blocked" : null}, updated_at = now()
    WHERE id = ${taskId}
  `);
  if (release) {
    // 离开工作链:释放租约但保留行(fencing 单调依赖历史)
    await exec.execute(sql`
      UPDATE leases SET lease_expires_at = now() WHERE task_id = ${taskId}
    `);
  }
  await appendAudit(exec, {
    actor: ownerId,
    authority: "WORKER",
    action: "ADVANCE",
    taskId,
    beforeState: fromState,
    afterState: toState,
    detail: { fencing: fencingToken, leaseReleased: release },
  });
  return { ok: true, taskId, state: toState, stateVersion: task.state_version + 1, leaseReleased: release };
}

// 心跳续租(必须处于事务内)。续租成功不写审计(高频路径,heartbeat_at 即记录);
// 过期/fenced/冒充/终态拒绝写审计。旧 fencing 的续租请求被拒 ⇒ 过期幽灵无法自我复活;
// 终态任务的心跳被拒 ⇒ 不可复活已关闭任务的租约(复核 F-3 TOCTOU 处置)。
export async function heartbeat(
  exec: Exec,
  taskId: string,
  ownerId: string,
  fencingToken: number,
  ttlSeconds: number,
): Promise<HeartbeatResult> {
  const task = await lockTask(exec, taskId);
  if (isTerminal(task.state)) {
    await auditHeartbeatRejected(exec, taskId, ownerId, fencingToken, `state_terminal:${task.state}`);
    return { ok: false, reason: `state_terminal:${task.state}` };
  }
  const lease = await lockLease(exec, taskId);
  if (!lease) {
    await auditHeartbeatRejected(exec, taskId, ownerId, fencingToken, "no_lease");
    return { ok: false, reason: "no_lease" };
  }
  if (lease.owner_id !== ownerId) {
    await auditHeartbeatRejected(exec, taskId, ownerId, fencingToken, `lease_owner_mismatch:${lease.owner_id}`);
    return { ok: false, reason: "lease_owner_mismatch" };
  }
  if (Number(lease.fencing_token) !== fencingToken) {
    await auditHeartbeatRejected(exec, taskId, ownerId, fencingToken, `fenced:token=${lease.fencing_token}`);
    return { ok: false, reason: "fenced" };
  }
  if (!lease.live) {
    await auditHeartbeatRejected(exec, taskId, ownerId, fencingToken, "lease_expired");
    return { ok: false, reason: "lease_expired" };
  }
  const res = await exec.execute(sql`
    UPDATE leases SET lease_expires_at = now() + make_interval(secs => ${ttlSeconds}),
      heartbeat_at = now()
    WHERE task_id = ${taskId}
    RETURNING lease_expires_at
  `);
  return { ok: true, leaseExpiresAt: String(res.rows[0]?.["lease_expires_at"]) };
}

async function auditHeartbeatRejected(
  exec: Exec,
  taskId: string,
  ownerId: string,
  fencingToken: number,
  reason: string,
): Promise<void> {
  await appendAudit(exec, {
    actor: ownerId,
    authority: "WORKER",
    action: "HEARTBEAT_REJECTED",
    taskId,
    detail: { reason, fencingToken },
  });
}
