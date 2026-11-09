// V04 延伸(P0-01B):Run 中 Worker 被真实 SIGKILL → TTL 过期 → Supervisor 回收
// → fencing+1 重领 → **从 DB 重建上下文**(resume_mode=context_rebuild)再跑。
// 同时断言:旧 token 非法推进被拒(失效 Run 不产生状态副作用)、审计链完整。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask, advanceTask } from "../../src/core/lease.ts";
import { supervisorTick } from "../../src/core/supervisor.ts";
import { connectDb, type Exec, type RelayDb } from "../../src/core/db.ts";
import { spawnHelper, kill9AndAssertDead, sleep, waitFor, type HelperChild } from "../helpers/fault-injection.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun, latestSession } from "../../src/runtime/runner.ts";
import { cleanupSandbox } from "../../src/runtime/sandbox.ts";
import { assertOk, assertAdvanceFail } from "../setup/assert.ts";

const DB_URL = process.env.RELAY_DB_URL ?? "postgresql://postgres:relayp000local@127.0.0.1:55433/relayp000";
const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;

describe("Run 崩溃恢复:SIGKILL → Tick 回收 → context_rebuild(V04 延伸)", () => {
  let t: TestDb;
  let scoped: { db: RelayDb; pool: import("pg").Pool };
  let worker: HelperChild | null = null;
  const sandboxes: import("../../src/runtime/sandbox.ts").SandboxSpec[] = [];

  beforeAll(async () => {
    t = await createTestDb("run-crash");
    await t.db.execute(sql`
      INSERT INTO tasks (id, state, goal_id, allowed_scope)
      VALUES ('t-crash', 'READY', 'crash goal', '["/workspace"]'::jsonb)
    `);
    scoped = connectDb(DB_URL, t.schemaName);
  });

  afterAll(async () => {
    worker?.kill("SIGKILL");
    for (const s of sandboxes) cleanupSandbox(s);
    await scoped?.pool.end();
    await t.cleanup();
  });

  it("全链路:A 被杀→回收→B 重领(fencing+1)→重建上下文→VERIFYING;旧 token 推进被拒", async () => {
    // 1) Worker A(独立进程):claim + stub hang Run
    worker = spawnHelper("run-worker.ts", [], {
      RELAY_DB_URL: DB_URL,
      RELAY_TEST_SCHEMA: t.schemaName,
      TASK_ID: "t-crash",
      OWNER: "worker-A",
      HEARTBEAT_S: "1",
      STUB_MODE: "hang",
    });
    // 等待 A 进入 RUNNING(run 行已建)
    await waitFor("run row of A", async () => {
      const r = await t.db.execute(sql`SELECT id FROM runs WHERE task_id='t-crash'`);
      return r.rows.length > 0 ? true : null;
    });
    await waitFor("state RUNNING", async () => {
      const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-crash'`);
      return String(r.rows[0]!["state"]) === "RUNNING" ? true : null;
    });
    const runA = await t.db.execute(sql`SELECT id, outcome FROM runs WHERE task_id='t-crash'`);
    const runAId = String(runA.rows[0]!["id"]);

    // 2) 真实 SIGKILL(进程死亡核验)
    await kill9AndAssertDead(worker);
    worker = null;

    // 崩溃现场:run 行无 ended_at(诚实遥测:崩溃 Run 不虚构结束)
    const crashed = await t.db.execute(sql`SELECT outcome, ended_at FROM runs WHERE id=${runAId}`);
    expect(crashed.rows[0]!["ended_at"]).toBeNull();

    // 3) TTL 过期(claim TTL=3s)→ Supervisor Tick:回收 + Reconcile + 以 worker-B 领取
    await sleep(3400);
    // A 的旧 fencing(回收前读取,fencing 单调依赖历史行)
    const aLease = await t.db.execute(sql`SELECT fencing_token, owner_id FROM leases WHERE task_id='t-crash'`);
    const oldOwner = String(aLease.rows[0]!["owner_id"]);
    const oldFencing = Number(aLease.rows[0]!["fencing_token"]);
    expect(oldOwner).toBe("worker-A");

    const tick = await supervisorTick(scoped.db, {
      actor: "supervisor-test",
      executor: { check: async () => { throw new Error("无 EXECUTING 意图,不应被调用"); }, perform: async () => { throw new Error("同上"); } },
      workerId: "worker-B",
      ttlSeconds: 60,
    });
    expect(tick.reclaimed.map((r) => r.taskId)).toContain("t-crash");
    expect(tick.claimed?.taskId).toBe("t-crash");
    expect(tick.claimed?.ownerId).toBe("worker-B");

    // 4) fencing 单调:新 claim = 旧 + 1
    const bFencing = tick.claimed!.fencingToken;
    expect(bFencing).toBe(oldFencing + 1);

    // 5) Worker B 从 DB 重建上下文(priorHandoff 来自崩溃 Run 的 session)
    const prior = await latestSession(scoped.db, "t-crash");
    expect(prior).not.toBeNull();
    expect(prior!.runId).toBe(runAId);

    const resultB = await executeRun(scoped.db, resolveVendoredPi(), {
      taskId: "t-crash",
      goal: "crash goal",
      allowedScope: ["/workspace"],
      attempt: tick.claimed!.attempt,
      ownerId: "worker-B",
      fencingToken: bFencing,
      model: { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" },
      sandbox: "host-fallback",
      wallSeconds: 20,
      heartbeatSeconds: 2,
      argvOverride: [process.execPath, STUB],
      envOverride: { STUB_MODE: "ok" },
      priorHandoff: { runId: prior!.runId, handoff: prior!.handoff },
    });
    sandboxes.push(resultB.sandboxSpec);
    expect(resultB.outcome).toBe("SUCCEEDED");

    // session2:resume_mode=context_rebuild,priorRunId 指向崩溃 Run
    const sessB = await t.db.execute(sql`
      SELECT resume_mode, handoff_ref FROM sessions WHERE run_id=${resultB.runId}
    `);
    expect(String(sessB.rows[0]!["resume_mode"])).toBe("context_rebuild");
    expect((sessB.rows[0]!["handoff_ref"] as Record<string, unknown>)["priorRunId"]).toBe(runAId);

    // 6) 旧 token 非法推进被拒(失效 Run 不产生状态副作用)
    const ghost = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-crash", oldOwner, oldFencing, "RUNNING", "SUBMITTED"),
    );
    assertAdvanceFail(ghost);
    expect(
      ghost.reason === "fenced" || ghost.reason.startsWith("fenced:") ||
      ghost.reason === "state_mismatch:VERIFYING" || ghost.reason === "lease_owner_mismatch",
    ).toBe(true);

    // 任务终态 VERIFYING(Gate 属测试/外部裁决)
    const finalState = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-crash'`);
    expect(String(finalState.rows[0]!["state"])).toBe("VERIFYING");

    // 审计链:RECLAIM_EXPIRED 存在
    const audit = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_events
      WHERE task_id='t-crash' AND action='RECLAIM_EXPIRED'
    `);
    expect(Number(audit.rows[0]!["n"])).toBeGreaterThanOrEqual(1);
  });
});
