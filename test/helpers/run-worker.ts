// Worker 辅助进程(SIGKILL 崩溃恢复测试的靶子):
// 领取任务 → executeRun(stub RPC 挂起模式)→ 保持至被杀或 Run 结束。
// env:RELAY_DB_URL / RELAY_TEST_SCHEMA / TASK_ID / OWNER / HEARTBEAT_S / STUB_MODE / STUB_PID_FILE
// 结束或启动失败都向 stdout 打印一行 ===WORKER-RESULT=== {json}(崩溃路径自然无输出)。
import { sql } from "drizzle-orm";
import { connectDb } from "../../src/core/db.ts";
import { claimTask } from "../../src/core/lease.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun } from "../../src/runtime/runner.ts";

const dbUrl = process.env.RELAY_DB_URL!;
const schema = process.env.RELAY_TEST_SCHEMA!;
const taskId = process.env.TASK_ID!;
const owner = process.env.OWNER ?? "worker-crash";
const heartbeatS = Number(process.env.HEARTBEAT_S ?? "1");
const stubMode = process.env.STUB_MODE ?? "hang";

const { db, pool } = connectDb(dbUrl, schema);
const c = await db.transaction((tx) => claimTask(tx, taskId, owner, heartbeatS * 3));
if (!c.ok) {
  console.log("===WORKER-RESULT===" + JSON.stringify({ claim: c }));
  process.exit(1);
}
try {
  const result = await executeRun(db, resolveVendoredPi(), {
    taskId,
    goal: "crash-recovery stub goal",
    allowedScope: ["/workspace"],
    attempt: c.attempt,
    ownerId: c.ownerId,
    fencingToken: c.fencingToken,
    model: { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" },
    sandbox: "host-fallback",
    wallSeconds: 120,
    heartbeatSeconds: heartbeatS,
    argvOverride: [process.execPath, new URL("./stub-pi.mjs", import.meta.url).pathname],
    envOverride: { STUB_MODE: stubMode, STUB_PID_FILE: process.env.STUB_PID_FILE ?? "" },
  });
  console.log("===WORKER-RESULT===" + JSON.stringify({ claim: c, result: { runId: result.runId, outcome: result.outcome } }));
} finally {
  await pool.end();
}
