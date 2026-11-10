// Goal Loop 辅助进程(重启恢复测试靶子):startGoalLoop + executeRun(stub)。
// env:RELAY_DB_URL / RELAY_TEST_SCHEMA / STUB_MODE / INTERVAL_MS / OWNER
import { sql } from "drizzle-orm";
import { connectDb } from "../../src/core/db.ts";
import { startGoalLoop } from "../../src/core/goal-loop.ts";
import { executeRun } from "../../src/runtime/runner.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";

const dbUrl = process.env.RELAY_DB_URL!;
const schema = process.env.RELAY_TEST_SCHEMA!;
const stubMode = process.env.STUB_MODE ?? "ok";
const intervalMs = Number(process.env.INTERVAL_MS ?? "300");
const owner = process.env.OWNER ?? "loop-worker";
const pi = resolveVendoredPi();

const { db, pool } = connectDb(dbUrl, schema);
const loop = startGoalLoop(db, {
  intervalMs,
  workerId: owner,
  ttlSeconds: 30,
  circuitThreshold: 3,
  backoffBaseSeconds: 1,
  runTask: async (claim) => {
    const result = await executeRun(db, pi, {
      taskId: claim.taskId,
      goal: "loop stub goal",
      allowedScope: ["/workspace"],
      attempt: claim.attempt,
      ownerId: owner,
      fencingToken: claim.fencingToken,
      model: { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" },
      sandbox: "host-fallback",
      wallSeconds: 120,
      heartbeatSeconds: 1,
      argvOverride: [process.execPath, new URL("./stub-pi.mjs", import.meta.url).pathname],
      envOverride: { STUB_MODE: stubMode, STUB_PID_FILE: `/tmp/relay-loop-stub-${process.pid}` },
    });
    return { outcome: result.outcome, reason: String(result.detail["reason"] ?? ""), taskId: claim.taskId };
  },
});
void sql;
process.on("SIGTERM", async () => {
  await loop.stop();
  await pool.end();
  process.exit(0);
});
