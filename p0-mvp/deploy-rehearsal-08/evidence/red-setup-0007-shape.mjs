// RELAY-DEPLOY-REHEARSAL-08 B 项红态演示脚本(证据工具;只动本脚本新建的 p01a_* schema)。
// 在已授权测试 PG(127.0.0.1:55433/relayp000)下新建唯一 p01a_d08red_* schema,精确构造
// 0007 旧形状 + 最小合成行,然后演示三个既有工具缺口(修复前的反例实证):
//   RED-a  deploy/init-schema.ts 对已存在 schema 直接跳过 ⇒ 0008/0009 不会被补齐(不适合原位升级)
//   RED-b  src/core/db.ts applyMigrations 对已有 schema 全量重放 ⇒ 0000 CREATE TABLE 撞表崩溃
//   RED-c  0008 裸重跑(不检测标记)⇒ duplicate column 崩溃
// 结束时只清理本脚本创建的 schema(sentinel 自证)。连接串密码零打印。
import pg from "pg";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { applyMigrations, dropSchema } from "../../../src/core/db.ts";

const DB_URL = process.env.RELAY_DB_URL ?? "postgresql://postgres:relayp000local@127.0.0.1:55433/relayp000";
const SCHEMA = `p01a_d08red_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const MIGRATIONS_DIR = new URL("../../../migrations/", import.meta.url).pathname;

function sanitizeUrl(u) {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.hostname}:${x.port || 5432}${x.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
const report = { schema: SCHEMA, target: sanitizeUrl(DB_URL), steps: [] };
try {
  // ── 1) 构造 0007 形状:依 journal 顺序应用 idx 0..7(剥离 "public". 限定,search_path 决定目标) ──
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  const client = await pool.connect();
  await client.query(`SET search_path TO "${SCHEMA}"`);
  const journal = JSON.parse(await readFile(`${MIGRATIONS_DIR}meta/_journal.json`, "utf8"));
  const applied0007 = [];
  for (const entry of journal.entries.filter((e) => e.idx <= 7)) {
    const raw = await readFile(`${MIGRATIONS_DIR}${entry.tag}.sql`, "utf8");
    const normalized = raw.replaceAll('"public".', '"');
    for (const stmt of normalized.split("--> statement-breakpoint")) {
      const t = stmt.trim();
      if (t.length > 0) await client.query(t);
    }
    applied0007.push(entry.tag);
  }
  // 审计守卫与 init-schema 同源(createIsolatedSchema 末尾 GUARD)
  const { AUDIT_APPEND_ONLY_GUARD } = await import("../../../src/core/db.ts");
  await client.query(AUDIT_APPEND_ONLY_GUARD);
  await client.release();
  report.steps.push({ step: "build-0007-shape", applied: applied0007.length, tags: applied0007 });

  // ── 2) 最小合成行(纯合成数据;零生产数据) ──
  await pool.query(`SET search_path TO "${SCHEMA}"`);
  const c2 = await pool.connect();
  await c2.query(`SET search_path TO "${SCHEMA}"`);
  await c2.query(`INSERT INTO goals (id, raw_input, budget) VALUES ('goal-red-1', '08 红态演练合成目标(中文+jsonb 保真)', '{"modelCalls":4}'::jsonb)`);
  await c2.query(`INSERT INTO tasks (id, state, priority, allowed_scope, gate_required, max_attempts) VALUES ('task-red-1', 'SUCCEEDED', 2, '[]'::jsonb, true, 3)`);
  await c2.query(`INSERT INTO goal_messages (goal_id, actor, kind, content) VALUES ('goal-red-1', 'USER', 'USER_MESSAGE', '红态合成消息一'), ('goal-red-1', 'RELAY', 'RELAY_MESSAGE', '红态合成消息二')`);
  await c2.query(`INSERT INTO audit_events (actor, action, task_id, detail) VALUES ('rehearsal', 'RED_SETUP', 'task-red-1', '{"synthetic":true}'::jsonb)`);
  await c2.release();
  report.steps.push({ step: "synthetic-rows", goals: 1, tasks: 1, goal_messages: 2, audit: 1 });

  // ── 形状基线(修复前):0008/0009 标记应为 0 ──
  const shape = await pool.query(
    `SELECT
       (SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_name='goal_messages') g6,
       (SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_name='goal_message_consumptions') g7,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='goal_messages' AND column_name='execution_request') g8,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='abort_requested_at') g9`,
    [SCHEMA],
  );
  report.baselineShape = shape.rows[0];
  console.log(`[red-setup] 0007 形状标记 g6/g7/g8/g9 = ${JSON.stringify(shape.rows[0])}(预期 1/1/0/0)`);

  // ── RED-a:init-schema 对已存在 schema 跳过 ⇒ 0008/0009 不补齐 ──
  const outA = execFileSync("node", ["deploy/init-schema.ts", SCHEMA], { encoding: "utf8", cwd: new URL("../../..", import.meta.url).pathname, timeout: 60_000 });
  report.steps.push({ step: "RED-a-init-schema", output: outA.trim().split("\n") });
  const afterA = await pool.query(
    `SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='goal_messages' AND column_name='execution_request') g8,
            (SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='abort_requested_at') g9`,
    [SCHEMA],
  );
  console.log(`[RED-a] init-schema 输出=${outA.trim().split("\n").join(" | ")}`);
  console.log(`[RED-a] 跳过后 g8/g9 = ${JSON.stringify(afterA.rows[0])}(预期仍 0/0 ⇒ init-schema 不适合原位增量升级)`);

  // ── RED-b:applyMigrations 全量重放 ⇒ 撞表崩溃 ──
  const c3 = await pool.connect();
  let errB = null;
  try {
    await c3.query(`SET search_path TO "${SCHEMA}"`);
    await applyMigrations(c3, MIGRATIONS_DIR);
  } catch (e) {
    errB = e.message ?? String(e);
  } finally {
    c3.release();
  }
  console.log(`[RED-b] applyMigrations 全量重放对已有 schema ⇒ ${errB ? "崩溃(预期):" + errB.split("\n")[0] : "意外成功(反例不成立!)"}`);
  report.steps.push({ step: "RED-b-applyMigrations-replay", crashed: errB !== null, error: errB?.split("\n")[0] ?? null });

  // ── RED-c:0008 裸重跑 ⇒ duplicate column ──
  const c4 = await pool.connect();
  await c4.query(`SET search_path TO "${SCHEMA}"`);
  const sql8 = (await readFile(`${MIGRATIONS_DIR}0008_goal_messages_execution_request.sql`, "utf8")).split("--> statement-breakpoint")[0].trim();
  await c4.query(sql8); // 第一次成功
  let errC = null;
  try {
    await c4.query(sql8); // 裸重跑
  } catch (e) {
    errC = e.message ?? String(e);
  }
  c4.release();
  console.log(`[RED-c] 0008 首次执行成功;裸重跑 ⇒ ${errC ? "崩溃(预期):" + errC.split("\n")[0] : "意外成功(反例不成立!)"}`);
  report.steps.push({ step: "RED-c-0008-rerun", crashed: errC !== null, error: errC?.split("\n")[0] ?? null });

  console.log(`[red-setup] sentinel=${SCHEMA}(仅本 schema 将被清理)`);
  report.ok = true;
} catch (err) {
  report.ok = false;
  report.error = err.message ?? String(err);
  console.error(`[red-setup] 失败:${report.error}`);
  process.exitCode = 1;
} finally {
  // 只清理本脚本创建的 schema(带 sentinel 校验)
  if (report.ok !== false && SCHEMA.startsWith("p01a_d08red_")) {
    await dropSchema(pool, SCHEMA);
    console.log(`[red-setup] 已清理自建 schema ${SCHEMA}(其余 p01a_*/relay_console/public/soak24h 一律未触碰)`);
  }
  await pool.end();
}
console.log(JSON.stringify(report, null, 2));
