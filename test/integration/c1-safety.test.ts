// C-1 安全收口集成测试(真实 PG + 真实进程):
// 1) 心跳 DB 连续异常 ⇒ Run 止损(INTERRUPTED + stub 死亡核验 + 任务不被推进);
// 2) 工具事件 Worker 侧可信持久化(workspace 审计文件缺失时 DB 仍有 toolEvents);
// 3) exec 命令白名单的审计痕迹由 Worker 侧捕获(不依赖模型可写文件)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask } from "../../src/core/lease.ts";
import type { Exec } from "../../src/core/db.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun, readToolAudit } from "../../src/runtime/runner.ts";
import { cleanupSandbox } from "../../src/runtime/sandbox.ts";
import { assertOk } from "../setup/assert.ts";
import { waitFor } from "../helpers/fault-injection.ts";

const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };

function pidAlive(pid: number): Promise<boolean> {
  return new Promise((res) => execFile("ps", ["-p", String(pid)], (err) => res(!err)));
}

describe("C-1 心跳 DB 异常止损(合同 1)", () => {
  let t: TestDb;
  const sandboxes: import("../../src/runtime/sandbox.ts").SandboxSpec[] = [];
  beforeAll(async () => {
    t = await createTestDb("c1-hb-err");
  });
  afterAll(async () => {
    for (const s of sandboxes) cleanupSandbox(s);
    await t.cleanup();
  });

  it("第一次异常容忍,第二次连续异常 ⇒ INTERRUPTED + stub 死亡 + 任务停 RUNNING 待回收", async () => {
    await t.db.execute(sql`
      INSERT INTO tasks (id, state, goal_id, allowed_scope, allowed_commands)
      VALUES ('t-hberr', 'READY', 'g', '["/workspace"]'::jsonb, '[]'::jsonb)
    `);
    const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, "t-hberr", "worker-A", 60));
    assertOk(c);

    // 心跳注入:第 1 次抛错(容忍),之后一直抛错(第 2 次连续 ⇒ 止损)
    let calls = 0;
    const result = await executeRun(t.db, resolveVendoredPi(), {
      taskId: "t-hberr",
      goal: "g",
      allowedScope: ["/workspace"],
      attempt: c.attempt,
      ownerId: c.ownerId,
      fencingToken: c.fencingToken,
      model: MODEL,
      sandbox: "host-fallback",
      wallSeconds: 60,
      heartbeatSeconds: 0.2,
      heartbeatFn: async () => {
        calls += 1;
        throw new Error("db_connection_lost(注入)");
      },
      argvOverride: [process.execPath, STUB],
      envOverride: { STUB_MODE: "hang", STUB_PID_FILE: `/tmp/relay-c1-hb-${process.pid}` },
    });

    expect(result.outcome).toBe("INTERRUPTED");
    expect(result.detail["reason"]).toBe("heartbeat_errors");
    expect(result.detail["lastError"]).toContain("db_connection_lost");

    // stub 真实死亡(ps 核验)
    const pidFile = `/tmp/relay-c1-hb-${process.pid}`;
    expect(existsSync(pidFile)).toBe(true);
    const stubPid = Number(readFileSync(pidFile, "utf8").trim());
    await waitFor("stub dead", async () => ((await pidAlive(stubPid)) ? null : true), 8000);
    expect(await pidAlive(stubPid)).toBe(false);

    // 任务不被推进(权威不可验证):停留 RUNNING,由 Supervisor 过期回收收尾
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-hberr'`);
    expect(String(st.rows[0]!["state"])).toBe("RUNNING");
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("C-1 工具事件 Worker 侧可信持久化(合同 3)", () => {
  let t: TestDb;
  const sandboxes: import("../../src/runtime/sandbox.ts").SandboxSpec[] = [];
  beforeAll(async () => {
    t = await createTestDb("c1-toolev");
  });
  afterAll(async () => {
    for (const s of sandboxes) cleanupSandbox(s);
    await t.cleanup();
  });

  it("workspace 审计文件缺失时,runs.detail.toolEvents 仍有完整调用记录(含 DENIED)", async () => {
    await t.db.execute(sql`
      INSERT INTO tasks (id, state, goal_id, allowed_scope, allowed_commands)
      VALUES ('t-toolev', 'READY', 'g', '["/workspace"]'::jsonb, '[]'::jsonb)
    `);
    const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, "t-toolev", "worker-A", 60));
    assertOk(c);
    const result = await executeRun(t.db, resolveVendoredPi(), {
      taskId: "t-toolev",
      goal: "g",
      allowedScope: ["/workspace"],
      attempt: c.attempt,
      ownerId: c.ownerId,
      fencingToken: c.fencingToken,
      model: MODEL,
      sandbox: "host-fallback",
      wallSeconds: 20,
      heartbeatSeconds: 2,
      argvOverride: [process.execPath, STUB],
      envOverride: { STUB_MODE: "with-tools" },
    });
    expect(result.outcome).toBe("SUCCEEDED");
    // workspace 文件不存在(模型可写面为空)—— 辅助证据缺席
    expect(readToolAudit(result.sandboxSpec)).toEqual([]);
    // Worker 侧(RPC 事件流)记录完整 —— 安全验收依据
    const run = await t.db.execute(sql`SELECT detail FROM runs WHERE id=${result.runId}`);
    const detail = run.rows[0]!["detail"] as {
      toolEvents?: Array<{ type: string; name?: string; params?: { path?: string }; denied?: boolean }>;
      budget?: Record<string, unknown>;
    };
    expect(Array.isArray(detail.toolEvents)).toBe(true);
    const toolCalls = detail.toolEvents!.filter((e) => e.type === "tool_call");
    expect(toolCalls.length).toBe(2);
    expect(toolCalls.some((e) => e.params?.path === "/etc/passwd")).toBe(true);
    const toolResults = detail.toolEvents!.filter((e) => e.type === "tool_result");
    expect(toolResults.some((e) => e.denied === true)).toBe(true);
  });
});
