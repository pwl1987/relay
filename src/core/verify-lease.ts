// 独立验证租约(P0-02A C-5;修复 P0-01C REPORT §6-1 的 VERIFYING 残留 TTL 窗口)。
// 语义:Run 成功(RUNNING→VERIFYING 由 runner 完成)后,Gate 编排方立即接管租约——
//   fencing+1、owner=verifier ⇒ **模型 Worker 的残留 TTL 权威即时作废**
//   (旧 fencing 的 advance/heartbeat 全部被拒,不再有"Run 结束后 6s 窗口内必须完成 Gate"的隐式依赖)。
// - Reviewer Run 期间由编排方以 verifier 身份心跳续租(心跳连续异常 ⇒ 止损,停 Run,交回收);
// - Verifier 崩溃 ⇒ 租约到期 ⇒ 既有 reclaim 路径(VERIFYING 在工作链)→ NEEDS_RECONCILE → READY
//   → 新 attempt 重验:无假通过(Gate 绑定 attempt/sha)、无双重裁决(消费事务化一次性)。
// 时间权威在数据库(now());拒绝与接管均落审计。
import { sql } from "drizzle-orm";
import type { Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";
import { heartbeat } from "./lease.ts";

export type VerifyLeaseResult =
  | { ok: true; ownerId: string; fencingToken: number; expiresAt: string }
  | { ok: false; reason: string };

/**
 * 接管 VERIFYING 任务的租约到 Gate 编排方(单事务:行锁 → 校验 → 接管 → 审计)。
 * 前置:任务处于 VERIFYING(仅此状态接管);存在租约行(无论是否仍活——Run 刚结束时残留
 * TTL 仍活、或已过期被 reclaim 前的窗口,接管一律 fencing+1 使旧持有者失效)。
 */
export async function acquireVerificationLease(
  exec: Exec,
  taskId: string,
  verifierId: string,
  ttlSeconds: number,
): Promise<VerifyLeaseResult> {
  const taskRes = await exec.execute(sql`
    SELECT state FROM tasks WHERE id = ${taskId} FOR UPDATE
  `);
  const t = taskRes.rows[0];
  if (!t) return { ok: false, reason: "task_not_found" };
  const state = String(t["state"]);
  if (state !== "VERIFYING") return { ok: false, reason: `state_not_verifying:${state}` };

  const leaseRes = await exec.execute(sql`
    SELECT owner_id, fencing_token, (lease_expires_at > now()) AS live
    FROM leases WHERE task_id = ${taskId} FOR UPDATE
  `);
  const l = leaseRes.rows[0];
  if (!l) return { ok: false, reason: "no_lease" };
  const previousOwner = String(l["owner_id"]);
  const previousFencing = Number(l["fencing_token"]);
  const fencing = previousFencing + 1;

  const res = await exec.execute(sql`
    UPDATE leases SET owner_id = ${verifierId}, fencing_token = ${fencing},
      lease_expires_at = now() + make_interval(secs => ${ttlSeconds}), heartbeat_at = now()
    WHERE task_id = ${taskId}
    RETURNING lease_expires_at
  `);
  await appendAudit(exec, {
    actor: verifierId,
    authority: "GATE",
    action: "VERIFY_LEASE_ACQUIRED",
    taskId,
    detail: {
      previousOwner,
      previousFencing,
      fencing,
      ttlSeconds,
      previousLive: l["live"] === true,
      note: "验证租约接管:模型 Worker 残留 TTL 权威即时作废(P0-02A C-5)",
    },
  });
  return { ok: true, ownerId: verifierId, fencingToken: fencing, expiresAt: String(res.rows[0]?.["lease_expires_at"]) };
}

/** 验证租约心跳(编排方在 Reviewer Run 期间续租)。复用 lease.heartbeat(VERIFYING 在工作链内)。 */
export function heartbeatVerificationLease(
  exec: Exec,
  taskId: string,
  verifierId: string,
  fencingToken: number,
  ttlSeconds: number,
): Promise<{ ok: boolean; reason?: string }> {
  return heartbeat(exec, taskId, verifierId, fencingToken, ttlSeconds);
}

/** 显式终止验证租约(消费 BLOCK→NEEDS_DECISION 等离链路径;正常 PASS/REWORK 由 advance 释放)。 */
export async function expireVerificationLease(exec: Exec, taskId: string, actor: string): Promise<void> {
  await exec.execute(sql`UPDATE leases SET lease_expires_at = now() WHERE task_id = ${taskId}`);
  await appendAudit(exec, {
    actor,
    authority: "GATE",
    action: "VERIFY_LEASE_EXPIRED",
    taskId,
    detail: { note: "验证租约显式终止(离链状态不保留活跃租约)" },
  });
}
