// C-4 故障注入(真实 PG + 真实进程/信号):
// 1) 故意无限失败 ⇒ 有界停止(退避可观测 + 相同签名熔断 CIRCUIT_OPEN + goal FAILED,V11/US-09);
// 2) attempt 预算(非熔断路径)耗尽 ⇒ ATTEMPT_BUDGET_EXHAUSTED;
// 3) 重复/并发 Tick:恰好一个赢家(SKIP LOCKED);
// 4) 进程重启:loop 子进程被真实 SIGKILL → 新 loop 从 PG 恢复事实状态继续(无内存权威)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, databaseUrl, type TestDb } from "../setup/testdb.ts";
import { planGoal } from "../../src/core/goals.ts";
import { goalLoopTick, type RunOutcomeDigest } from "../../src/core/goal-loop.ts";
import { advanceTask } from "../../src/core/lease.ts";
import { randomUUID } from "node:crypto";

/** stub 专用:模拟 runner 的 runs 行落库(failureStreak 数据源)。 */
async function stubRunRow(
  db: { execute(q: ReturnType<typeof sql>): Promise<{ rows: Array<Record<string, unknown>> }> },
  taskId: string,
  outcome: string,
  reason: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO runs (id, task_id, attempt, model_ref, sandbox, outcome, detail, started_at, ended_at)
    VALUES (${"run-" + randomUUID()}, ${taskId}, 0, 'stub/stub', 'host-fallback', ${outcome},
      ${JSON.stringify({ reason })}::jsonb, now(), now())
  `);
}
import type { Exec } from "../../src/core/db.ts";
import { spawnHelper, kill9AndAssertDead, sleep, waitFor, type HelperChild } from "../helpers/fault-injection.ts";
import { connectDb } from "../../src/core/db.ts";
import { recordGateVerdict } from "../../src/core/gates.ts";

// P0-C:经 testdb 授权守卫解析(错误生产 URL fail-closed),不再裸读 env
const DB_URL = databaseUrl();
const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;

describe("熔断与 attempt 预算(故意无限失败 ⇒ 有界停止)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("c4-circuit");
  });
  afterAll(() => t.cleanup());

  it("相同失败签名连续 3 次 ⇒ CIRCUIT_OPEN,run 恰好 3 个,goal FAILED", async () => {
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: "goal-cir",
        rawInput: "无限失败任务",
        budget: { modelCalls: 50 },
        tasks: [{ id: "t-cir", goalText: "x", maxAttempts: 10 }],
      }),
    );
    let runCount = 0;
    const backoffs: number[] = [];
    for (let tick = 0; tick < 8; tick++) {
      const report = await goalLoopTick(t.db, {
        workerId: "w1",
        ttlSeconds: 60,
        circuitThreshold: 3,
        backoffBaseSeconds: 0.01, // 毫秒级退避便于测试;生产默认 10s
        runTask: async (claim) => {
          runCount += 1;
          // 模拟 runner 前半段:LEASED→RUNNING(runner 语义),失败返回
          await t.db.transaction(async (tx) =>
            advanceTask(tx as unknown as Exec, claim.taskId, "w1", claim.fencingToken, "LEASED", "RUNNING"),
          );
          await stubRunRow(t.db, claim.taskId, "FAILED", "rpc_disconnect");
          return { outcome: "FAILED", reason: "rpc_disconnect", taskId: claim.taskId };
        },
      });
      if (report.run?.disposition?.startsWith("retry_scheduled")) {
        backoffs.push(Number(report.run.disposition.split(":")[1]?.replace("s", "")));
      }
      const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-cir'`);
      if (String(st.rows[0]!["state"]) === "FAILED") break;
      await sleep(30); // 等退避到期
    }
    // 有界:恰好 3 次(熔断阈值)即停,不无限烧
    expect(runCount).toBe(3);
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-cir'`);
    expect(String(st.rows[0]!["state"])).toBe("FAILED");
    const audit = await t.db.execute(
      sql`SELECT detail FROM audit_events WHERE task_id='t-cir' AND action='CIRCUIT_OPEN'`,
    );
    expect(audit.rows.length).toBe(1);
    expect((audit.rows[0]!["detail"] as Record<string, unknown>)["streak"]).toBe(3);
    // 指数退避可观测(0.01s 基数:1x,2x)
    expect(backoffs.length).toBeGreaterThanOrEqual(2);
    expect(backoffs[1]!).toBeGreaterThan(backoffs[0]!);
    // goal 聚合:唯一任务 FAILED ⇒ goal FAILED
    const goal = await t.db.execute(sql`SELECT state FROM goals WHERE id='goal-cir'`);
    expect(String(goal.rows[0]!["state"])).toBe("FAILED");
  });

  it("失败签名不同 ⇒ 不熔断,attempt 预算耗尽走 ATTEMPT_BUDGET_EXHAUSTED", async () => {
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: "goal-att",
        rawInput: "attempt 预算",
        budget: { modelCalls: 50 },
        tasks: [{ id: "t-att", goalText: "x", maxAttempts: 2 }],
      }),
    );
    let runCount = 0;
    for (let tick = 0; tick < 6; tick++) {
      const report = await goalLoopTick(t.db, {
        workerId: "w1",
        ttlSeconds: 60,
        circuitThreshold: 3,
        backoffBaseSeconds: 0.01,
        runTask: async (claim) => {
          runCount += 1;
          await t.db.transaction(async (tx) =>
            advanceTask(tx as unknown as Exec, claim.taskId, "w1", claim.fencingToken, "LEASED", "RUNNING"),
          );
          await stubRunRow(t.db, claim.taskId, "FAILED", `err_variant_${runCount}`);
          return { outcome: "FAILED", reason: `err_variant_${runCount}`, taskId: claim.taskId };
        },
      });
      void report;
      const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-att'`);
      if (String(st.rows[0]!["state"]) === "FAILED") break;
      await sleep(30);
    }
    expect(runCount).toBe(2);
    const audit = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id='t-att' AND action='ATTEMPT_BUDGET_EXHAUSTED'`,
    );
    expect(Number(audit.rows[0]!["n"])).toBe(1);
    const circuit = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id='t-att' AND action='CIRCUIT_OPEN'`,
    );
    expect(Number(circuit.rows[0]!["n"])).toBe(0);
  });
});

describe("并发/重复 Tick 与进程重启恢复", () => {
  let t: TestDb;
  let loop: HelperChild | null = null;
  beforeAll(async () => {
    t = await createTestDb("c4-recover");
  });
  afterAll(async () => {
    loop?.kill("SIGKILL");
    await t.cleanup();
  });

  it("并发双 Tick:恰好一个赢家(单 Run,无双执行)", async () => {
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: "goal-dt",
        rawInput: "并发",
        budget: { modelCalls: 10 },
        tasks: [{ id: "t-dt", goalText: "x" }],
      }),
    );
    let runs = 0;
    const [r1, r2] = await Promise.all([
      goalLoopTick(t.db, {
        workerId: "w-parallel-1",
        ttlSeconds: 60,
        runTask: async (c) => {
          runs += 1;
          await t.db.transaction(async (tx) =>
            advanceTask(tx as unknown as Exec, c.taskId, "w-parallel-1", c.fencingToken, "LEASED", "RUNNING"),
          );
          return { outcome: "SUCCEEDED", taskId: c.taskId };
        },
      }),
      goalLoopTick(t.db, {
        workerId: "w-parallel-2",
        ttlSeconds: 60,
        runTask: async (c) => {
          runs += 1;
          await t.db.transaction(async (tx) =>
            advanceTask(tx as unknown as Exec, c.taskId, "w-parallel-2", c.fencingToken, "LEASED", "RUNNING"),
          );
          return { outcome: "SUCCEEDED", taskId: c.taskId };
        },
      }),
    ]);
    const claims = [r1.tick?.claimed, r2.tick?.claimed].filter(Boolean);
    expect(claims.length).toBe(1); // 恰好一个赢家
    expect(runs).toBe(1); // 恰好一次执行
  });

  it("loop 子进程 SIGKILL → 新 loop 从 PG 恢复:状态事实仍在库,任务走到 VERIFYING(旧租约回收)", async () => {
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: "goal-rs",
        rawInput: "重启恢复",
        budget: { modelCalls: 10 },
        tasks: [{ id: "t-rs", goalText: "x" }],
      }),
    );
    // 第一个 loop:stub 挂起(Run 永不完成)
    loop = spawnHelper("run-loop.ts", [], {
      RELAY_DB_URL: DB_URL,
      RELAY_TEST_SCHEMA: t.schemaName,
      STUB_MODE: "hang",
      INTERVAL_MS: "200",
      OWNER: "loop-A",
    });
    await waitFor(
      "loop-A 领取并 RUNNING",
      async () => {
        const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-rs'`);
        return String(r.rows[0]!["state"]) === "RUNNING" ? true : null;
      },
      20000,
    );

    // 真实 SIGKILL + 死亡核验
    await kill9AndAssertDead(loop);
    loop = null;

    // TTL 过期 → 回收 + Reconcile(READY);claim 留给"重启后的新 loop"
    await t.db.execute(sql`UPDATE leases SET lease_expires_at = now() - interval '1s' WHERE task_id='t-rs'`);
    const { reclaimExpiredLeases, reconcilePendingTasks } = await import("../../src/core/supervisor.ts");
    const reclaimed = await t.db.transaction(async (tx) => reclaimExpiredLeases(tx as unknown as Exec, "recover-test"));
    expect(reclaimed.map((r) => r.taskId)).toContain("t-rs");
    const rec = await reconcilePendingTasks(
      t.db,
      {
        check: async () => {
          throw new Error("无 EXECUTING 意图");
        },
        perform: async () => {
          throw new Error("同上");
        },
      },
      "recover-test",
    );
    expect(rec.map((r) => r.taskId)).toContain("t-rs");
    const readyState = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-rs'`);
    expect(String(readyState.rows[0]!["state"])).toBe("READY");

    // 新 loop(进程重启语义:一切从库读)以 loop-B 身份完成 Run;失败签名不延续(不同任务历史)
    const report = await goalLoopTick(t.db, {
      workerId: "loop-B",
      ttlSeconds: 60,
      runTask: async (claim) => {
        // 模拟 runner:LEASED→RUNNING→SUBMITTED→VERIFYING(经 advanceTask,租约权威内)
        for (const [from, to] of [
          ["LEASED", "RUNNING"],
          ["RUNNING", "SUBMITTED"],
          ["SUBMITTED", "VERIFYING"],
        ] as const) {
          const r = await t.db.transaction(async (tx) =>
            advanceTask(tx as unknown as Exec, claim.taskId, "loop-B", claim.fencingToken, from, to),
          );
          if (!r.ok) throw new Error(`advance ${from}->${to} 被拒: ${r.reason}`);
        }
        return { outcome: "SUCCEEDED", taskId: claim.taskId };
      },
    });
    expect(report.status).toBe("PROGRESSED");
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-rs'`);
    expect(String(st.rows[0]!["state"])).toBe("VERIFYING");
    // 审计链:RECLAIM_EXPIRED 存在(崩溃被记账,不是静默重做)
    const audit = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id='t-rs' AND action='RECLAIM_EXPIRED'`,
    );
    expect(Number(audit.rows[0]!["n"])).toBeGreaterThanOrEqual(1);
    void STUB;
    void recordGateVerdict;
  });
});
