// 子进程 worker helper:claim -> LEASED->RUNNING -> 无限持有。
// 供真实 SIGKILL 故障注入(V04/B3b)。父进程负责:播种任务 -> spawn 本文件 -> 等 RUNNING -> kill -9。
// 用法: node hold-worker.ts <taskId> <ownerId> <ttlSec>
// env: RELAY_DB_URL, RELAY_TEST_SCHEMA
import { connectDb, type Exec } from "../../src/core/db.ts";
import { claimTask, advanceTask } from "../../src/core/lease.ts";

const [taskId, ownerId, ttlSec] = process.argv.slice(2);
if (!taskId || !ownerId || !ttlSec) {
  console.error("usage: node hold-worker.ts <taskId> <ownerId> <ttlSec>");
  process.exit(2);
}
const url = process.env.RELAY_DB_URL;
const schemaName = process.env.RELAY_TEST_SCHEMA;
if (!url || !schemaName) {
  console.error("RELAY_DB_URL / RELAY_TEST_SCHEMA required");
  process.exit(2);
}

const { pool, db } = connectDb(url, schemaName);
const claim = await db.transaction(async (tx) =>
  claimTask(tx as unknown as Exec, taskId, ownerId, Number(ttlSec)),
);
if (!claim.ok) {
  console.log(JSON.stringify({ op: "claim", ok: false, reason: claim.reason }));
  await pool.end();
  process.exit(1);
}
const advance = await db.transaction(async (tx) =>
  advanceTask(tx as unknown as Exec, taskId, ownerId, claim.fencingToken, "LEASED", "RUNNING"),
);
if (!advance.ok) {
  console.log(JSON.stringify({ op: "advance", ok: false, reason: advance.reason }));
  await pool.end();
  process.exit(1);
}
console.log(JSON.stringify({ op: "ready", ok: true, fencingToken: claim.fencingToken, pid: process.pid }));
// 无限持有直至被 SIGKILL(不优雅退出——这正是故障注入目标)
setInterval(() => {}, 1000);
