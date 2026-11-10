// P0-02A C-5:VERIFYING 独立验证租约——修复 P0-01C "Run 结束后残留 TTL" 边界。
// 反例(合同三、条款 5):Worker 在 VERIFYING 前后崩溃 ⇒ 无假通过、无双重裁决、无永久失联。
// 接管语义:fencing+1、owner=verifier ⇒ 模型 Worker 残留 TTL 权威**即时作废**(advance/heartbeat 全拒)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask, advanceTask, heartbeat } from "../../src/core/lease.ts";
import { reclaimExpiredLeases } from "../../src/core/supervisor.ts";
import { acquireVerificationLease, heartbeatVerificationLease, expireVerificationLease } from "../../src/core/verify-lease.ts";
import { assertOk, assertAdvanceFail, assertAdvanceOk } from "../setup/assert.ts";
import type { Exec } from "../../src/core/db.ts";

describe("独立验证租约(VERIFYING 不依赖残留 TTL)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("c5-verify-lease");
  });
  afterAll(() => t.cleanup());

  async function chainToVerifying(taskId: string): Promise<{ ownerId: string; fencingToken: number; attempt: number }> {
    await t.db.execute(sql`
      INSERT INTO tasks (id, state, allowed_scope) VALUES (${taskId}, 'READY', '["/workspace"]'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `);
    const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, taskId, `worker-${taskId}`, 60));
    assertOk(c);
    for (const [from, to] of [["LEASED", "RUNNING"], ["RUNNING", "SUBMITTED"], ["SUBMITTED", "VERIFYING"]] as const) {
      const r = await t.db.transaction(async (tx) =>
        advanceTask(tx as unknown as Exec, taskId, c.ownerId, c.fencingToken, from, to),
      );
      assertAdvanceOk(r);
    }
    return { ownerId: c.ownerId, fencingToken: c.fencingToken, attempt: c.attempt };
  }

  it("接管即作废残留 TTL:旧 Worker advance/heartbeat 全拒;verifier 心跳可用", async () => {
    const w = await chainToVerifying("t-vl-1");
    // Run 刚结束:worker 租约仍有残留 TTL —— 此刻接管
    const vl = await t.db.transaction(async (tx) =>
      acquireVerificationLease(tx as unknown as Exec, "t-vl-1", "verifier-1", 60),
    );
    expect(vl.ok).toBe(true);
    if (!vl.ok) return;
    expect(vl.fencingToken).toBe(w.fencingToken + 1);

    // 旧 Worker 的一切权威即时作废(fencing 先于 owner 校验)
    const ghostAdvance = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-vl-1", w.ownerId, w.fencingToken, "VERIFYING", "ACCEPTED"),
    );
    assertAdvanceFail(ghostAdvance);
    expect(ghostAdvance.reason).toMatch(/fenced|owner_mismatch/);
    const ghostHeartbeat = await t.db.transaction(async (tx) =>
      heartbeat(tx as unknown as Exec, "t-vl-1", w.ownerId, w.fencingToken, 10),
    );
    expect(ghostHeartbeat.ok).toBe(false);
    expect(ghostHeartbeat.reason).toMatch(/fenced|owner_mismatch/);

    // verifier 心跳正常续租(VERIFYING 在工作链内)
    const hb = await t.db.transaction(async (tx) =>
      heartbeatVerificationLease(tx as unknown as Exec, "t-vl-1", "verifier-1", vl.fencingToken, 60),
    );
    expect(hb.ok).toBe(true);

    // 非VERIFYING 状态拒绝接管:先经 REWORK(非 gated 转移)离开 VERIFYING
    const advRework = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-vl-1", "verifier-1", vl.fencingToken, "VERIFYING", "REWORK"),
    );
    assertAdvanceOk(advRework);
    const wrongState = await t.db.transaction(async (tx) =>
      acquireVerificationLease(tx as unknown as Exec, "t-vl-1", "verifier-2", 60),
    );
    expect(wrongState.ok).toBe(false);
    expect((wrongState as { reason: string }).reason).toMatch(/state_not_verifying/);
  });

  it("Verifier 崩溃三角:裁决已记录未消费 + 租约到期 ⇒ 回收重验,旧 PASS 失效,无假通过/无失联", async () => {
    const w = await chainToVerifying("t-vl-2");
    const vl = await t.db.transaction(async (tx) =>
      acquireVerificationLease(tx as unknown as Exec, "t-vl-2", "verifier-2", 60),
    );
    expect(vl.ok).toBe(true);
    if (!vl.ok) return;
    // 场景:verifier 已记录 PASS(未消费)即崩溃;任务停 VERIFYING,租约随 TTL 过期
    await t.db.execute(sql`
      INSERT INTO task_gate_verdicts (id, task_id, commit_ref, verdict, reviewer, attempt, candidate_sha, requirement_sha)
      VALUES ('gate-vl-orphan', 't-vl-2', NULL, 'PASS', 'verifier-2', ${w.attempt}, NULL, NULL)
    `);
    // 模拟 TTL 到期(supervisor 只做过期回收,不做窗口内强收)
    await t.db.execute(sql`UPDATE leases SET lease_expires_at = now() - interval '1s' WHERE task_id='t-vl-2'`);
    const reclaimed = await t.db.transaction(async (tx) => reclaimExpiredLeases(tx as unknown as Exec, "supervisor"));
    expect(reclaimed.map((r) => r.taskId)).toEqual(["t-vl-2"]);
    expect(reclaimed[0]!.fromState).toBe("VERIFYING");
    // 回收 → READY(reconcile 无 EXECUTING 意图)
    await t.db.execute(sql`
      UPDATE tasks SET state='READY', state_version=state_version+1, updated_at=now()
      WHERE id='t-vl-2' AND state='NEEDS_RECONCILE'
    `);
    // 新 Worker 重领:attempt+1,任务可恢复(无永久失联)
    const c2 = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, "t-vl-2", "worker-next", 60));
    assertOk(c2);
    expect(c2.attempt).toBe(2);
    // 孤儿 PASS 消费尝试:新租约权威下被拒(先因 state_mismatch —— 任务已 LEASED 非 VERIFYING;
    // 即便推回 VERIFYING,attempt 绑定失配亦拒)—— 双保险断言
    const consumeState = await t.db.transaction(async (tx) => {
      const { consumeGateVerdict } = await import("../../src/core/gates.ts");
      return consumeGateVerdict(tx as unknown as Exec, {
        taskId: "t-vl-2", gateId: "gate-vl-orphan", actor: "attacker",
        ownerId: c2.ownerId, fencingToken: c2.fencingToken,
      });
    });
    expect(consumeState.ok).toBe(false);
    const reason = (consumeState as { reason: string }).reason;
    expect(reason === "already_consumed" || reason.startsWith("stale_attempt") || reason.startsWith("state_mismatch")).toBe(true);
    // 显式离链路径的租约终止助手可用(BLOCK→NEEDS_DECISION 用)
    await t.db.transaction(async (tx) => expireVerificationLease(tx as unknown as Exec, "t-vl-2", "verifier-x"));
    const st = await t.db.execute(sql`
      SELECT (SELECT state FROM tasks WHERE id='t-vl-2') AS task_state,
             (SELECT lease_expires_at > now() FROM leases WHERE task_id='t-vl-2') AS lease_live
    `);
    expect(String(st.rows[0]!["task_state"])).toBe("LEASED");
    expect(st.rows[0]!["lease_live"]).toBe(false);
  });
});
