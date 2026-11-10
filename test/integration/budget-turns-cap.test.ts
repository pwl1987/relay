// 回合硬顶专属测试(复核 MAJOR-1 修复):stub 多回合真实进程,
// reserveCallsPerRun < stub 总回合 ⇒ Run 中 SIGKILL 止损 + BUDGET_EXHAUSTED + 任务 BLOCKED,
// 且账本结算 used = 硬顶值(机械证明单个 Run 无法突破预留)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask } from "../../src/core/lease.ts";
import { ensureLedgerRow, ledgerSnapshot } from "../../src/core/budget.ts";
import type { Exec } from "../../src/core/db.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun } from "../../src/runtime/runner.ts";
import { cleanupSandbox } from "../../src/runtime/sandbox.ts";
import { assertOk } from "../setup/assert.ts";
import { waitFor } from "../helpers/fault-injection.ts";

const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };

function pidAlive(pid: number): Promise<boolean> {
  return new Promise((res) => execFile("ps", ["-p", String(pid)], (err) => res(!err)));
}

describe("回合硬顶(机器强制预算,Run 中)", () => {
  let t: TestDb;
  const sandboxes: import("../../src/runtime/sandbox.ts").SandboxSpec[] = [];
  beforeAll(async () => {
    t = await createTestDb("c2-cap");
  });
  afterAll(async () => {
    for (const s of sandboxes) cleanupSandbox(s);
    await t.cleanup();
  });

  it("cap=2 < stub 5 回合 ⇒ BUDGET_EXHAUSTED(budget_turns_cap)+ stub 死亡 + 任务 BLOCKED + used=2", async () => {
    const goalId = "goal-cap";
    await t.db.execute(sql`INSERT INTO goals (id, raw_input, state, budget) VALUES (${goalId}, 'g', 'ACTIVE', '{"modelCalls":2}'::jsonb)`);
    await ensureLedgerRow(t.db as unknown as Exec, { scopeType: "goal", scopeId: goalId, kind: "model_calls", limit: 2 });
    await t.db.execute(sql`
      INSERT INTO tasks (id, goal_id, state, allowed_scope) VALUES ('t-cap', ${goalId}, 'READY', '["/workspace"]'::jsonb)
    `);
    const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, "t-cap", "worker-A", 60));
    assertOk(c);

    const pidFile = `/tmp/relay-cap-stub-${process.pid}`;
    const result = await executeRun(t.db, resolveVendoredPi(), {
      taskId: "t-cap",
      goal: "g",
      allowedScope: ["/workspace"],
      attempt: c.attempt,
      ownerId: c.ownerId,
      fencingToken: c.fencingToken,
      model: MODEL,
      sandbox: "host-fallback",
      wallSeconds: 60,
      heartbeatSeconds: 2,
      budget: { goalId, reserveCallsPerRun: 2 },
      argvOverride: [process.execPath, STUB],
      envOverride: { STUB_MODE: "chatty", STUB_TURNS: "5", STUB_PID_FILE: pidFile },
    });

    // Run 中止损
    expect(result.outcome).toBe("BUDGET_EXHAUSTED");
    expect(result.detail["reason"]).toBe("budget_turns_cap");
    expect(result.detail["cap"]).toBe(2);
    expect(result.detail["turns"]).toBe(2); // 恰好在硬顶处停,未吞第 3 回合

    // stub 真实死亡
    expect(existsSync(pidFile)).toBe(true);
    const stubPid = Number(readFileSync(pidFile, "utf8").trim());
    await waitFor("stub dead", async () => ((await pidAlive(stubPid)) ? null : true), 8000);
    expect(await pidAlive(stubPid)).toBe(false);

    // 任务 BLOCKED(budget_exhausted)
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-cap'`);
    expect(String(st.rows[0]!["state"])).toBe("BLOCKED");
    // run 行如实落 BUDGET_EXHAUSTED
    const run = await t.db.execute(sql`SELECT outcome FROM runs WHERE id=${result.runId}`);
    expect(String(run.rows[0]!["outcome"])).toBe("BUDGET_EXHAUSTED");

    // 账本:used=2(= 硬顶),预留释放 —— 机械证明单 Run 无法突破预留
    const snap = (await ledgerSnapshot(t.db, "goal", goalId)).find((x) => x.kind === "model_calls")!;
    expect(snap.used).toBe(2);
    expect(snap.reserved).toBe(0);
    expect(snap.used).toBeLessThanOrEqual(snap.limit!);
  });
});
