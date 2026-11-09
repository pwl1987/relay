// Supervisor Tick:优先级领取、预算拒绝、REWORK 释放、NEEDS_RECONCILE 恢复、空转。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, seedTask, type TestDb } from "../setup/testdb.ts";
import { advanceTask, claimTask } from "../../src/core/lease.ts";
import { supervisorTick } from "../../src/core/supervisor.ts";
import type { Exec } from "../../src/core/db.ts";
import { assertAdvanceOk, assertOk } from "../setup/assert.ts";

const dummyExecutor = { check: async () => "", perform: async () => {} };

describe("Supervisor Tick", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("tick");
  });
  afterAll(() => t.cleanup());

  it("优先级高的 READY 先被领取;无任务时空转", async () => {
    await seedTask(t.db, { id: "tick-low", priority: 0 });
    await seedTask(t.db, { id: "tick-high", priority: 5 });
    const r1 = await supervisorTick(t.db, { workerId: "w1", executor: dummyExecutor });
    expect(r1.claimed!.taskId).toBe("tick-high");
    const r2 = await supervisorTick(t.db, { workerId: "w1", executor: dummyExecutor });
    expect(r2.claimed!.taskId).toBe("tick-low");
    const r3 = await supervisorTick(t.db, { workerId: "w1", executor: dummyExecutor });
    expect(r3.claimed).toBeNull();
  });

  it("attempt 预算耗尽:REWORK 回 READY 后拒绝再领,拒绝留审计", async () => {
    await seedTask(t.db, { id: "tick-budget", maxAttempts: 1 });
    const c = await t.db.transaction(async (tx) =>
      claimTask(tx as unknown as Exec, "tick-budget", "w1", 30),
    );
    assertOk(c);
    // 完成一次链路至 REWORK(gate REWORK)
    for (const [from, to] of [["LEASED", "RUNNING"], ["RUNNING", "SUBMITTED"], ["SUBMITTED", "VERIFYING"], ["VERIFYING", "REWORK"]] as const) {
      const r = await t.db.transaction(async (tx) =>
        advanceTask(tx as unknown as Exec, "tick-budget", "w1", c.fencingToken, from, to),
      );
      assertAdvanceOk(r);
    }
    // tick 释放 REWORK → READY,但 attempt=1 已达 max
    const r1 = await supervisorTick(t.db, { workerId: "w1", executor: dummyExecutor });
    expect(r1.reworkReleased).toEqual(["tick-budget"]);
    const r2 = await supervisorTick(t.db, { workerId: "w1", executor: dummyExecutor });
    expect(r2.claimed).toBeNull();
    const audit = await t.db.execute(sql`
      SELECT detail FROM audit_events WHERE task_id='tick-budget' AND action='CLAIM_REJECTED'
      ORDER BY seq DESC LIMIT 1
    `);
    expect((audit.rows[0]!["detail"] as Record<string, unknown>)["reason"]).toBe("attempt_budget_exhausted");
  });

  it("NEEDS_RECONCILE(无 EXECUTING 意图)由 tick 恢复为 READY 并在同拍被领取", async () => {
    await seedTask(t.db, { id: "tick-nr" });
    await t.db.execute(sql`
      UPDATE tasks SET state='NEEDS_RECONCILE', state_version=state_version+1 WHERE id='tick-nr'
    `);
    const r = await supervisorTick(t.db, { workerId: "w1", executor: dummyExecutor });
    const entry = r.reconciled.find((x) => x.taskId === "tick-nr");
    expect(entry!.toState).toBe("READY");
    // 同一拍内:恢复 READY 后 claim 步骤立即领取 ⇒ 终态 LEASED(唯一 READY 任务)
    expect(r.claimed!.taskId).toBe("tick-nr");
    const state = await t.db.execute(sql`SELECT state FROM tasks WHERE id='tick-nr'`);
    expect(state.rows[0]!["state"]).toBe("LEASED");
    const audit = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_events WHERE task_id='tick-nr' AND action='RECONCILE_READY'
    `);
    expect(Number(audit.rows[0]!["n"])).toBe(1);
  });
});
