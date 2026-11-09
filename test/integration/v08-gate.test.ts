// V08 最小门锁:VERIFYING->ACCEPTED 必须存在 PASS 裁决;REWORK/BLOCK 路径与终态锁定。
// 语义:Coder/Agent 自报完成(SUBMITTED)不能直接变成 ACCEPTED(US-07)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, seedTask, type TestDb } from "../setup/testdb.ts";
import { claimTask, advanceTask } from "../../src/core/lease.ts";
import { recordGateVerdict } from "../../src/core/gates.ts";
import { releaseRework } from "../../src/core/supervisor.ts";
import type { Exec } from "../../src/core/db.ts";
import { assertAdvanceFail, assertAdvanceOk, assertOk } from "../setup/assert.ts";

describe("V08 Gate 门锁", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("v08-gate");
    await seedTask(t.db, { id: "t-gate", gateRequired: true });
    await seedTask(t.db, { id: "t-nogate", gateRequired: false });
  });
  afterAll(() => t.cleanup());

  async function chainToVerifying(taskId: string, owner: string, fencing: number): Promise<void> {
    for (const [from, to] of [
      ["LEASED", "RUNNING"],
      ["RUNNING", "SUBMITTED"],
      ["SUBMITTED", "VERIFYING"],
    ] as const) {
      const r = await t.db.transaction(async (tx) =>
        advanceTask(tx as unknown as Exec, taskId, owner, fencing, from, to),
      );
      assertAdvanceOk(r);
    }
  }

  it("无 PASS 裁决时 VERIFYING->ACCEPTED 被拒(gate_not_passed)", async () => {
    const c = await t.db.transaction(async (tx) =>
      claimTask(tx as unknown as Exec, "t-gate", "coder-1", 30),
    );
    assertOk(c);
    await chainToVerifying("t-gate", "coder-1", c.fencingToken);

    const noGate = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-gate", "coder-1", c.fencingToken, "VERIFYING", "ACCEPTED"),
    );
    assertAdvanceFail(noGate);
    expect(noGate.reason).toBe("gate_not_passed");
    // 状态未被修改,任务仍在 VERIFYING
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-gate'`);
    expect(st.rows[0]!["state"]).toBe("VERIFYING");
  });

  it("REWORK 裁决 → VERIFYING->REWORK → tick 释放回 READY → 重领重验", async () => {
    await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, {
        taskId: "t-gate",
        verdict: "REWORK",
        reviewer: "reviewer-1",
        commitRef: "deadbeef",
      }),
    );
    const rework = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-gate", "coder-1", 1, "VERIFYING", "REWORK"),
    );
    assertAdvanceOk(rework);
    expect(rework.leaseReleased).toBe(true); // 离开工作链释放租约

    await t.db.transaction(async (tx) => releaseRework(tx as unknown as Exec, "supervisor"));
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-gate'`);
    expect(st.rows[0]!["state"]).toBe("READY");

    // 第二 attempt:重领(fencing 单调 +1)→ VERIFYING → PASS → ACCEPTED
    const c2 = await t.db.transaction(async (tx) =>
      claimTask(tx as unknown as Exec, "t-gate", "coder-1", 30),
    );
    assertOk(c2);
    expect(c2.fencingToken).toBe(2);
    expect(c2.attempt).toBe(2);
    await chainToVerifying("t-gate", "coder-1", 2);
    await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, {
        taskId: "t-gate",
        verdict: "PASS",
        reviewer: "reviewer-2",
        commitRef: "cafe1234",
      }),
    );
    const accepted = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-gate", "coder-1", 2, "VERIFYING", "ACCEPTED"),
    );
    assertAdvanceOk(accepted);
  });

  it("gate_required=false 的任务可无裁决验收(平凡任务显式豁免)", async () => {
    const c = await t.db.transaction(async (tx) =>
      claimTask(tx as unknown as Exec, "t-nogate", "coder-1", 30),
    );
    assertOk(c);
    await chainToVerifying("t-nogate", "coder-1", c.fencingToken);
    const r = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-nogate", "coder-1", c.fencingToken, "VERIFYING", "ACCEPTED"),
    );
    assertAdvanceOk(r);
  });

  it("Gate 裁决本身留审计(authority=GATE)", async () => {
    const audit = await t.db.execute(sql`
      SELECT action, authority FROM audit_events WHERE action LIKE 'GATE_%' ORDER BY seq
    `);
    const actions = audit.rows.map((r) => String(r["action"]));
    expect(actions).toContain("GATE_REWORK");
    expect(actions).toContain("GATE_PASS");
    for (const row of audit.rows) {
      expect(String(row["authority"])).toBe("GATE");
    }
  });
});
