// P0-02A C-7:循环异常可观测/熔断/恢复(合同三、条款 7;P0-01C F-8 收口)。
// 反例:PostgreSQL 连续异常不能静默无限循环 —— 连续计数、逐次回调、达阈值熔断(停止调度);
// 成功即清零;恢复 = 新循环实例(进程重启语义,事实状态全在 PG)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { startSafeLoop } from "../../src/core/loop-safety.ts";
import { startGoalLoop } from "../../src/core/goal-loop.ts";
import { startSupervisorLoop } from "../../src/core/supervisor.ts";
import type { RelayDb } from "../../src/core/db.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function failingDb(inner: RelayDb, failAfter: number): RelayDb {
  let calls = 0;
  return {
    execute: async (q: Parameters<RelayDb["execute"]>[0]) => {
      calls += 1;
      if (calls > failAfter) throw new Error(`pg_down_simulated#${calls}`);
      return inner.execute(q);
    },
    transaction: async (cb: Parameters<RelayDb["transaction"]>[0]) => {
      calls += 1;
      if (calls > failAfter) throw new Error(`pg_down_simulated#${calls}`);
      return inner.transaction(cb);
    },
  } as RelayDb;
}

describe("循环安全器(连续异常 ⇒ 可观测 + 熔断;成功清零;重启恢复)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("c7-loop-circuit");
    await t.db.execute(sql`INSERT INTO tasks (id, state) VALUES ('t-c7', 'READY')`);
  });
  afterAll(() => t.cleanup());

  it("startSafeLoop:连续 throw 达阈值 ⇒ 逐次回调 + 熔断停止调度(不静默无限循环)", async () => {
    let invocations = 0;
    const errors: number[] = [];
    let openAt = -1;
    const handle = startSafeLoop(async () => {
      invocations += 1;
      throw new Error("tick_boom");
    }, {
      intervalMs: 25,
      errorThreshold: 3,
      onTickError: (_e, n) => errors.push(n),
      onCircuitOpen: (_e, n) => (openAt = n),
    });
    await sleep(400);
    await handle.stop();
    expect(errors).toEqual([1, 2, 3]); // 恰好三次,逐次可观测
    expect(openAt).toBe(3);
    expect(handle.circuitOpen()).toBe(true);
    const atStop = invocations;
    expect(atStop).toBe(3); // 熔断后不再调度新 tick
    await sleep(150);
    expect(invocations).toBe(atStop); // 时间推进仍无新调用(无限循环被熔断打破)
  });

  it("成功清零:交替 throw/成功 ⇒ 连续计数被清零,永不熔断", async () => {
    let calls = 0;
    let opened = false;
    const handle = startSafeLoop(async () => {
      calls += 1;
      if (calls % 2 === 1) throw new Error("flappy"); // 奇数失败、偶数成功 ⇒ 连续最多 1
    }, {
      intervalMs: 25,
      errorThreshold: 3,
      onCircuitOpen: () => (opened = true),
    });
    await sleep(400);
    await handle.stop();
    expect(calls).toBeGreaterThanOrEqual(6); // 交替跑了足够多拍
    expect(handle.circuitOpen()).toBe(false); // 成功清零 ⇒ 永不熔断
    expect(opened).toBe(false);
  });

  it("startGoalLoop 接真实 PG:连续 DB 异常 ⇒ TICK_ERROR 审计尽力落库 + 熔断;新循环实例恢复推进", async () => {
    const bad = failingDb(t.db, 0); // execute 全炸(模拟 PG 连续异常)
    const errors: number[] = [];
    let opened = false;
    const loop = startGoalLoop(bad, {
      intervalMs: 25,
      errorThreshold: 3,
      onTickError: (_e, n) => errors.push(n),
      onCircuitOpen: () => (opened = true),
    });
    await sleep(350);
    await loop.stop();
    expect(errors).toEqual([1, 2, 3]);
    expect(opened).toBe(true);
    expect(loop.circuitOpen()).toBe(true);

    // 恢复:新循环实例(进程重启语义)从 PG 恢复事实状态,正常推进领任务
    const fresh = startGoalLoop(t.db, { intervalMs: 40, ttlSeconds: 30 });
    await sleep(250);
    await fresh.stop();
    const audit = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_events WHERE action='CLAIM' AND task_id='t-c7'
    `);
    expect(Number(audit.rows[0]!["n"])).toBe(1);
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-c7'`);
    expect(String(st.rows[0]!["state"])).toBe("LEASED");
  });

  it("startSupervisorLoop 同样熔断(TICK_ERROR 审计尽力而为)", async () => {
    const bad = failingDb(t.db, 0);
    const errors: number[] = [];
    let opened = false;
    const loop = startSupervisorLoop(bad, {
      intervalMs: 25,
      errorThreshold: 2,
      onTickError: (_e, n) => errors.push(n),
      onCircuitOpen: () => (opened = true),
    });
    await sleep(250);
    await loop.stop();
    expect(errors).toEqual([1, 2]);
    expect(opened).toBe(true);
  });
});
