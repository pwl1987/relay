// V06/B1:并发 Tick 双 Worker 争抢同一 Task —— 恰好一个赢家,非持有者推进被拒(BLOCK 级)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask, advanceTask } from "../../src/core/lease.ts";
import type { Exec } from "../../src/core/db.ts";
import { assertAdvanceFail, assertAdvanceOk, assertOk } from "../setup/assert.ts";

describe("V06 并发 claim(B1 语义)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("v06-concurrent");
    await t.db.execute(sql`
      INSERT INTO tasks (id, state) VALUES ('t-v06', 'READY')
    `);
  });
  afterAll(() => t.cleanup());

  it("6 个并发 claim:恰好 1 个赢家,其余 state_not_claimable", async () => {
    const owners = ["w1", "w2", "w3", "w4", "w5", "w6"];
    const results = await Promise.all(
      owners.map((owner) =>
        t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, "t-v06", owner, 30)),
      ),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const losers = results.filter((r) => !r.ok);
    expect(losers).toHaveLength(5);
    for (const l of losers) {
      expect(l.reason).toBe("state_not_claimable:LEASED");
    }
    expect(winners[0]!.fencingToken).toBe(1);

    // 只有持有者能推进;非持有者与重复推进被拒
    const winner = winners[0]!;
    const losersAdvance = await Promise.all(
      owners
        .filter((o) => o !== winner.ownerId)
        .map((owner) =>
          t.db.transaction(async (tx) =>
            advanceTask(tx as unknown as Exec, "t-v06", owner, 1, "LEASED", "RUNNING"),
          ),
        ),
    );
    for (const r of losersAdvance) {
      assertAdvanceFail(r);
      expect(r.reason).toMatch(/lease_owner_mismatch|fenced/);
    }
    const holderAdvance = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-v06", winner.ownerId, winner.fencingToken, "LEASED", "RUNNING"),
    );
    assertAdvanceOk(holderAdvance);

    // 重复推进(状态已变)→ state_mismatch
    const repeat = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-v06", winner.ownerId, winner.fencingToken, "LEASED", "RUNNING"),
    );
    assertAdvanceFail(repeat);
    expect(repeat.reason).toBe("state_mismatch:RUNNING");
  });

  it("拒绝事件全部落审计(append-only)", async () => {
    const res = await t.db.execute(sql`
      SELECT action, count(*)::int AS n FROM audit_events WHERE task_id = 't-v06'
      GROUP BY action ORDER BY action
    `);
    const byAction = new Map(res.rows.map((r) => [String(r["action"]), Number(r["n"])]));
    expect(byAction.get("CLAIM")).toBe(1);
    expect(byAction.get("CLAIM_REJECTED")).toBe(5);
    expect(byAction.get("ADVANCE")).toBe(1);
    expect((byAction.get("ADVANCE_REJECTED") ?? 0)).toBeGreaterThanOrEqual(6);
  });
});
