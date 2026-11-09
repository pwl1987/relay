// 心跳续租:有效持有者延长 TTL;过期/fenced/冒充的续租被拒并留审计。
// 这是"TTL=权威窗口"契约的 Worker 侧义务:长任务必须心跳,否则 Supervisor 过期回收。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask, advanceTask, heartbeat } from "../../src/core/lease.ts";
import type { Exec } from "../../src/core/db.ts";
import { assertOk } from "../setup/assert.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("心跳续租", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("heartbeat");
    await t.db.execute(sql`INSERT INTO tasks (id, state) VALUES ('t-hb', 'READY')`);
  });
  afterAll(() => t.cleanup());

  it("有效续租延长窗口;stale fencing 续租被拒", async () => {
    const a = await t.db.transaction(async (tx) =>
      claimTask(tx as unknown as Exec, "t-hb", "worker-A", 2),
    );
    assertOk(a);
    const before = await t.db.execute(sql`SELECT lease_expires_at FROM leases WHERE task_id='t-hb'`);

    const renewed = await t.db.transaction(async (tx) =>
      heartbeat(tx as unknown as Exec, "t-hb", "worker-A", a.fencingToken, 30),
    );
    expect(renewed.ok).toBe(true);
    const after = await t.db.execute(sql`SELECT lease_expires_at FROM leases WHERE task_id='t-hb'`);
    expect(String(after.rows[0]!["lease_expires_at"]) > String(before.rows[0]!["lease_expires_at"])).toBe(true);

    // 旧 fencing(冒充 token 2)续租 → fenced
    const stale = await t.db.transaction(async (tx) =>
      heartbeat(tx as unknown as Exec, "t-hb", "worker-A", 2, 30),
    );
    expect(stale.ok).toBe(false);
    expect(stale.reason).toBe("fenced");
  });

  it("过期后续租被拒;新 Worker 回收领取", async () => {
    // 重置到 READY 以便用短 TTL 重新领取
    await t.db.execute(sql`
      UPDATE tasks SET state='READY', state_version=state_version+1, updated_at=now() WHERE id='t-hb'
    `);
    await t.db.execute(sql`UPDATE leases SET lease_expires_at = now() WHERE task_id='t-hb'`);
    const a = await t.db.transaction(async (tx) =>
      claimTask(tx as unknown as Exec, "t-hb", "worker-A", 1),
    );
    assertOk(a);
    await sleep(1300);
    const expired = await t.db.transaction(async (tx) =>
      heartbeat(tx as unknown as Exec, "t-hb", "worker-A", a.fencingToken, 30),
    );
    expect(expired.ok).toBe(false);
    expect(expired.reason).toBe("lease_expired");

    const b = await t.db.transaction(async (tx) =>
      claimTask(tx as unknown as Exec, "t-hb", "worker-B", 30),
    );
    assertOk(b);
    expect(b.fencingToken).toBe(a.fencingToken + 1);
  });

  it("终态任务心跳被拒(不可复活已关闭任务的租约;复核 F-3)", async () => {
    await t.db.execute(sql`UPDATE tasks SET state='ACCEPTED' WHERE id='t-hb'`);
    const ghost = await t.db.transaction(async (tx) =>
      heartbeat(tx as unknown as Exec, "t-hb", "worker-B", 999, 30),
    );
    expect(ghost.ok).toBe(false);
    expect(ghost.reason).toBe("state_terminal:ACCEPTED");
    await t.db.execute(sql`UPDATE tasks SET state='FAILED' WHERE id='t-hb'`); // 还原供审计计数
  });

  it("续租拒绝全部落审计", async () => {
    const res = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_events
      WHERE task_id='t-hb' AND action='HEARTBEAT_REJECTED'
    `);
    expect(Number(res.rows[0]!["n"])).toBeGreaterThanOrEqual(2);
  });
});
