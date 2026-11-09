// 子进程 executor:执行指定 action_intent(git push 外部副作用)。
// pre/post 停顿参数为受控故障注入钩子(非生产路径,默认 0):
//   prePauseMs  > 0:标记 EXECUTING 后、push 前停顿(C2 "执行前被杀"窗口)
//   postPauseMs > 0:push 已发生、COMPLETED 回执未写时停顿(C1 "丢回执"窗口)
// 用法: node push-execute.ts <intentId> <prePauseMs> <postPauseMs>
// env: RELAY_DB_URL, RELAY_TEST_SCHEMA, RELAY_SRC_REPO
import { connectDb } from "../../src/core/db.ts";
import { executeIntent } from "../../src/core/intents.ts";
import { createGitPushExecutor } from "../../src/core/executors/git-push.ts";

const [intentId, prePauseMs, postPauseMs] = process.argv.slice(2);
if (!intentId) {
  console.error("usage: node push-execute.ts <intentId> <prePauseMs> <postPauseMs>");
  process.exit(2);
}
const url = process.env.RELAY_DB_URL;
const schemaName = process.env.RELAY_TEST_SCHEMA;
const srcRepo = process.env.RELAY_SRC_REPO;
if (!url || !schemaName || !srcRepo) {
  console.error("RELAY_DB_URL / RELAY_TEST_SCHEMA / RELAY_SRC_REPO required");
  process.exit(2);
}

const { pool, db } = connectDb(url, schemaName);
const result = await executeIntent(
  db,
  createGitPushExecutor({ sourceRepo: srcRepo }),
  intentId,
  {
    preActionPauseMs: Number(prePauseMs ?? 0),
    postActionPauseMs: Number(postPauseMs ?? 0),
    actor: "child-executor",
  },
);
console.log(JSON.stringify({ op: "execute", pid: process.pid, ...result }));
await pool.end();
process.exit(result.ok ? 0 : 1);
