// B2:租约过期 + fencing —— 过期后新 Worker 以 token+1 回收;旧持有者旧 Token 必须 FENCED;冒充被拒。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask, advanceTask } from "../../src/core/lease.ts";
import type { Exec } from "../../src/core/db.ts";
import { assertAdvanceFail, assertAdvanceOk, assertOk } from "../setup/assert.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("B2 租约过期与 fencing", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("b2-expiry");
    await t.db.execute(sql`INSERT INTO tasks (id, state) VALUES ('t-b2', 'READY')`);
  });
  afterAll(() => t.cleanup());

  it("过期回收:fencing 单调 +1;旧 Token 与冒充一律被拒", async () => {
    const a = await t.db.transaction(async (tx) =>
      claimTask(tx as unknown as Exec, "t-b2", "worker-A", 1), // TTL 1s
    );
    assertOk(a);
    await sleep(1400); // 等待过期

    const b = await t.db.transaction(async (tx) =>
      claimTask(tx as unknown as Exec, "t-b2", "worker-B", 30),
    );
    assertOk(b);
    expect(b.fencingToken).toBe(2); // 单调 +1
    expect(b.reclaimedExpired).toBe(true);

    // 旧持有者旧 token → fenced
    const stale = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-b2", "worker-A", 1, "LEASED", "RUNNING"),
    );
    assertAdvanceFail(stale);
    expect(stale.reason).toBe("fenced:token=2");

    // 旧持有者冒充新 token → owner mismatch
    const impersonate = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-b2", "worker-A", 2, "LEASED", "RUNNING"),
    );
    assertAdvanceFail(impersonate);
    expect(impersonate.reason).toBe("lease_owner_mismatch:worker-B");

    // 新持有者新 token → 通过
    const ok = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-b2", "worker-B", 2, "LEASED", "RUNNING"),
    );
    assertAdvanceOk(ok);
    expect(ok.state).toBe("RUNNING");
  });
});
