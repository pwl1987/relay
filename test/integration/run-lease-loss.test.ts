// 失效 Run 止损(合同条款 4):租约被回收(或出工作链)后,
// Runner 的下一次心跳被拒 ⇒ 立即 SIGKILL RPC 子进程,run=INTERRUPTED,不做任何任务推进。
// 侧效应停止以真实进程死亡核验(ps 轮询)证明。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask } from "../../src/core/lease.ts";
import { reclaimExpiredLeases } from "../../src/core/supervisor.ts";
import type { Exec } from "../../src/core/db.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun } from "../../src/runtime/runner.ts";
import { cleanupSandbox } from "../../src/runtime/sandbox.ts";
import { assertOk } from "../setup/assert.ts";
import { waitFor } from "../helpers/fault-injection.ts";

const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;

function pidAlive(pid: number): Promise<boolean> {
  return new Promise((res) => {
    execFile("ps", ["-p", String(pid)], (err) => res(!err)); // ps 找到进程 exit 0
  });
}

describe("失效 Run 止损:租约丢失 → RPC 子进程立即终止", () => {
  let t: TestDb;
  const sandboxes: import("../../src/runtime/sandbox.ts").SandboxSpec[] = [];
  beforeAll(async () => {
    t = await createTestDb("run-lease-loss");
  });
  afterAll(async () => {
    for (const s of sandboxes) cleanupSandbox(s);
    await t.cleanup();
  });

  it("reclaim 后:心跳被拒(state_not_leased_chain)→ stub 被杀 → run=INTERRUPTED → 任务不被 A 推进", async () => {
    await t.db.execute(sql`
      INSERT INTO tasks (id, state, goal_id, allowed_scope)
      VALUES ('t-loss', 'READY', 'loss goal', '["/workspace"]'::jsonb)
    `);
    const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, "t-loss", "worker-A", 60));
    assertOk(c);

    const pidFile = `/tmp/relay-stub-pid-${process.pid}-${Date.now()}`;
    const runPromise = executeRun(t.db, resolveVendoredPi(), {
      taskId: "t-loss",
      goal: "loss goal",
      allowedScope: ["/workspace"],
      attempt: c.attempt,
      ownerId: c.ownerId,
      fencingToken: c.fencingToken,
      model: { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" },
      sandbox: "host-fallback",
      wallSeconds: 60,
      heartbeatSeconds: 0.3, // TTL=0.9s,心跳密拍以便快速感知回收
      argvOverride: [process.execPath, STUB],
      envOverride: { STUB_MODE: "hang", STUB_PID_FILE: pidFile },
    });

    // 等 stub 启动并拿到其真实 pid
    await waitFor("stub pid file", async () => (existsSync(pidFile) ? true : null));
    const stubPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(await pidAlive(stubPid)).toBe(true);

    // 等任务进入 RUNNING(runner 的第一个 advance),然后模拟 Supervisor 回收:
    // 置租约过期 + reclaimExpiredLeases(真实路径)
    await waitFor("task RUNNING", async () => {
      const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-loss'`);
      return String(r.rows[0]!["state"]) === "RUNNING" ? true : null;
    });
    await t.db.execute(sql`UPDATE leases SET lease_expires_at = now() - interval '1s' WHERE task_id='t-loss'`);
    const reclaimed = await t.db.transaction(async (tx) => reclaimExpiredLeases(tx as unknown as Exec));
    expect(reclaimed.map((r) => r.taskId)).toContain("t-loss");

    // Runner 下一次心跳(≤0.3s)被拒 ⇒ 止损
    const result = await runPromise;
    expect(result.outcome).toBe("INTERRUPTED");
    expect(result.detail["reason"]).toBe("lease_lost");

    // RPC 子进程真实死亡(ps 核验;等待合理宽限)
    await waitFor("stub process dead", async () => ((await pidAlive(stubPid)) ? null : true), 8000, 100);
    expect(await pidAlive(stubPid)).toBe(false);

    // 任务停留在 NEEDS_RECONCILE(回收态),A 未做任何推进
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-loss'`);
    expect(String(st.rows[0]!["state"])).toBe("NEEDS_RECONCILE");

    // A 的心跳拒绝留审计,且无 A 的 ADVANCE 记录
    const hbRej = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_events
      WHERE task_id='t-loss' AND action='HEARTBEAT_REJECTED'
        AND detail->>'reason' = 'state_not_leased_chain:NEEDS_RECONCILE'
    `);
    expect(Number(hbRej.rows[0]!["n"])).toBeGreaterThanOrEqual(1);
    const advByA = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_events
      WHERE task_id='t-loss' AND action='ADVANCE' AND actor='worker-A'
    `);
    expect(Number(advByA.rows[0]!["n"])).toBe(1); // 仅 LEASED→RUNNING 那一次(回收前)
  });
});
