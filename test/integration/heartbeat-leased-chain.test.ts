// F-3 残余窗口回归(P0-01B 收口,真实 PG):心跳权威仅在工作链内。
// 两条被实证过的路径均必须拒绝:
//   A) worker 合法 advance RUNNING→NEEDS_RECONCILE(转移表允许,租约仍活)→ 旧持有者心跳必须被拒;
//   B) 租约过期 → supervisor reclaim → NEEDS_RECONCILE → 旧 token 心跳必须被拒。
// 正向对照:工作链内(RUNNING)同 token 心跳仍成功,证明修复未误伤正常续租。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask, advanceTask, heartbeat } from "../../src/core/lease.ts";
import { reclaimExpiredLeases } from "../../src/core/supervisor.ts";
import type { Exec } from "../../src/core/db.ts";
import { assertOk, assertAdvanceOk, assertAdvanceFail } from "../setup/assert.ts";

describe("F-3 回归:非工作链状态心跳被拒", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("hb-leased-chain");
    await t.db.execute(sql`INSERT INTO tasks (id, state) VALUES ('t-f3', 'READY')`);
  });
  afterAll(() => t.cleanup());

  it("路径 A:advance→NEEDS_RECONCILE 后活租约心跳被拒;RUNNING 内心跳仍成功(正向对照)", async () => {
    const a = await t.db.transaction(async (tx) =>
      claimTask(tx as unknown as Exec, "t-f3", "worker-A", 30),
    );
    assertOk(a);
    const toRunning = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-f3", "worker-A", a.fencingToken, "LEASED", "RUNNING"),
    );
    assertAdvanceOk(toRunning);

    // 正向对照:工作链内心跳成功(修复不得误伤正常续租)
    const inChain = await t.db.transaction(async (tx) =>
      heartbeat(tx as unknown as Exec, "t-f3", "worker-A", a.fencingToken, 30),
    );
    expect(inChain.ok).toBe(true);

    // worker 主动进入 NEEDS_RECONCILE(合法转移;P0-01A 中该 advance 不释放租约)
    const toNr = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-f3", "worker-A", a.fencingToken, "RUNNING", "NEEDS_RECONCILE"),
    );
    assertAdvanceOk(toNr);

    // 修复点:出工作链后,即使租约仍活、owner/fencing 全对,心跳也必须被拒
    const zombie = await t.db.transaction(async (tx) =>
      heartbeat(tx as unknown as Exec, "t-f3", "worker-A", a.fencingToken, 30),
    );
    expect(zombie.ok).toBe(false);
    expect(zombie.reason).toBe("state_not_leased_chain:NEEDS_RECONCILE");

    // 拒绝留审计
    const audit = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_events
      WHERE task_id='t-f3' AND action='HEARTBEAT_REJECTED'
        AND detail->>'reason' = 'state_not_leased_chain:NEEDS_RECONCILE'
    `);
    expect(Number(audit.rows[0]!["n"])).toBe(1);
  });

  it("路径 B:reclaim 后旧 token 心跳被拒;旧 token 非法推进亦被拒", async () => {
    // 重置 READY 重新领取(短 TTL 便于过期)
    await t.db.execute(sql`
      UPDATE tasks SET state='READY', state_version=state_version+1, updated_at=now() WHERE id='t-f3'
    `);
    const b = await t.db.transaction(async (tx) =>
      claimTask(tx as unknown as Exec, "t-f3", "worker-B", 30),
    );
    assertOk(b);
    const toRunning = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-f3", "worker-B", b.fencingToken, "LEASED", "RUNNING"),
    );
    assertAdvanceOk(toRunning);

    // 模拟租约过期 → supervisor 回收
    await t.db.execute(sql`UPDATE leases SET lease_expires_at = now() - interval '1s' WHERE task_id='t-f3'`);
    const reclaimed = await t.db.transaction(async (tx) => reclaimExpiredLeases(tx as unknown as Exec));
    expect(reclaimed.map((r) => r.taskId)).toContain("t-f3");
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-f3'`);
    expect(String(st.rows[0]!["state"])).toBe("NEEDS_RECONCILE");

    // 僵尸(worker-B,token 未变)心跳:必须拒绝,且原因是出链而非仅 lease_expired
    const ghostHb = await t.db.transaction(async (tx) =>
      heartbeat(tx as unknown as Exec, "t-f3", "worker-B", b.fencingToken, 30),
    );
    expect(ghostHb.ok).toBe(false);
    expect(ghostHb.reason).toBe("state_not_leased_chain:NEEDS_RECONCILE");

    // 旧 token 非法推进同样被拒(失效 Run 不得继续产生状态副作用)
    const ghostAdv = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-f3", "worker-B", b.fencingToken, "RUNNING", "SUBMITTED"),
    );
    assertAdvanceFail(ghostAdv);
    expect(["state_mismatch:NEEDS_RECONCILE", "lease_expired", "fenced"]).toContain(ghostAdv.reason);
  });
});
