// RELAY-DEPLOY-REHEARSAL-08:离线增量迁移演练入口(0007→0008→0009 原位升级)。
// 背景(合同 A/B 反例实证,evidence/red-phase-existing-tools.log):
//   - deploy/init-schema.ts 对已存在 schema 见 goals 表即跳过 ⇒ 0008/0009 不会被补齐(不适合原位升级);
//   - src/core/db.ts applyMigrations 依 journal 全量重放(0000 CREATE TABLE 撞表崩溃)⇒ 不能用于已有 schema;
//   - 0008/0009 裸重跑(不检测标记)⇒ duplicate column 崩溃;
//   ⇒ 增量升级此前无安全入口,生产补齐(写 relay_console schema)必须用户单独 D3 授权。
// 本工具(合同 C 最小实现):
//   - plan 模式:只读(仅 information_schema 聚合计数,与 deploy/preflight.ts 同口径,零原始数据);
//     对生产 relay_console 输出"拟执行 SQL/前置/后置/回滚审批材料"(绝不直接执行);
//   - apply 模式:**仅接受显式隔离测试 schema(p01a_ 前缀)**与回环显式端口连接串 —— 在任何
//     连接/写入之前 fail-closed 拒绝(relay_console/public/soak24h/非回环/未显式端口一律拒);
//     逐步事务 + SET LOCAL search_path 钉死目标 schema + 每步后验标记 + 标记检测跳过已应用
//     (重复执行不盲撞)+ fail-at 注入(半迁移断点可定位、可续跑、不假 GO)+ 总后验
//     (列定义/默认值回填/append-only 触发器/FK/行数守恒)。
//   - 不引入通用迁移框架、不建第二 schema 真相源;SQL 一律取自 migrations/ 真实文件。
// 硬边界:本工具对生产永不执行 apply;生产切换须用户单独 D3 授权后按 Runbook 人工执行。
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { DEFAULT_TEST_DATABASE_URL } from "../src/core/db.ts";
import { AUDIT_APPEND_ONLY_GUARD } from "../src/core/db.ts";

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../migrations");

/** 迁移 journal 当前最大 idx(0009)。若未来新增迁移,须同步扩展本工具演练范围(测试守卫提醒)。 */
export const MIGRATION_JOURNAL_MAX_IDX = 9;

/** 本包演练范围的增量迁移(0008/0009;journal idx → tag)。 */
const REHEARSAL_RANGE = [
  { idx: 8, tag: "0008_goal_messages_execution_request" },
  { idx: 9, tag: "0009_tasks_abort_requested" },
] as const;

/** 演练范围允许的目标 schema 前缀(与 test/setup/testdb.ts 的测试隔离纪律同源)。 */
const ALLOWED_SCHEMA_PREFIX = "p01a_";

/** 与生产/既有命名空间同库共存的保留 schema(apply 一律拒绝;plan 只读允许)。 */
const RESERVED_SCHEMAS = new Set(["relay_console", "public", "soak24h", "dbos", "p002b_probe"]);

/** 连接串脱敏(日志/报告零凭据):仅保留 protocol//host:port/db。 */
export function sanitizeDbUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable-db-url)";
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`非法 schema 标识符:${name.slice(0, 8)}***(fail-closed)`);
  }
  return `"${name}"`;
}

/**
 * apply 目标守卫(fail-closed):**在任何连接/写入之前**同步拒绝。
 *  - 保留 schema(relay_console=生产 schema 与测试同库实例/public/soak24h/dbos/p002b_probe)⇒ 拒绝;
 *  - 非 p01a_ 前缀 ⇒ 拒绝(与 testdb 测试隔离纪律同源);
 *  - 连接串非回环主机/未显式端口/库名为空 ⇒ 拒绝(生产 RELAY_DB_URL 形态一律不可达本工具)。
 * 注意:拒绝只依据显式入参,不做任何网络探测 —— "看起来可达"不构成授权。
 */
export function assertApplyTargetAuthorized(schema: string, url: string): void {
  if (RESERVED_SCHEMAS.has(schema)) {
    throw new Error(
      `演练目标拒绝:${schema} 是保留 schema(生产 relay_console 与测试共享同一 PG 实例;public/soak24h 为既有命名空间);` +
        `演练只允许显式隔离测试 schema(${ALLOWED_SCHEMA_PREFIX}*);未执行任何连接或写入`,
    );
  }
  if (!schema.startsWith(ALLOWED_SCHEMA_PREFIX)) {
    throw new Error(`演练目标拒绝:schema 必须以 ${ALLOWED_SCHEMA_PREFIX} 开头(得到 ${schema ? schema.slice(0, 8) + "***" : "(空)"});未执行任何连接或写入`);
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new Error(`演练目标拒绝: schema 含非法标识符字符;未执行任何连接或写入`);
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`演练目标拒绝:连接串不是合法 URL(${sanitizeDbUrl(url)});未执行任何连接或写入`);
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(u.hostname)) {
    throw new Error(`演练目标拒绝:连接串主机非回环(${u.hostname};只允许 127.0.0.1/localhost/::1);未执行任何连接或写入`);
  }
  if (u.port === "") {
    throw new Error(`演练目标拒绝:连接串未显式端口(隐式 5432 不接受;必须显式声明目标端口);未执行任何连接或写入`);
  }
  if (u.pathname.replace(/^\//, "").length === 0) {
    throw new Error("演练目标拒绝:连接串库名为空;未执行任何连接或写入");
  }
}

interface JournalEntry {
  idx: number;
  tag: string;
}

async function readJournal(): Promise<JournalEntry[]> {
  const journalPath = path.join(MIGRATIONS_DIR, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: JournalEntry[] };
  return journal.entries;
}

/** 迁移文件 → 语句数组(剥离 "public". 限定,search_path 决定目标;与 applyMigrations 同语义;剔除纯注释块)。 */
async function migrationStatements(tag: string): Promise<string[]> {
  const raw = await readFile(path.join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
  const normalized = raw.replaceAll('"public".', '"');
  return normalized
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.split("\n").every((l) => l.trim().startsWith("--")));
}

export interface MigrationShape {
  schema: string;
  supported: boolean;
  verdict: "incremental_upgrade_available" | "already_up_to_date" | "unsupported_shape";
  appliedTags: string[];
  pendingTags: string[];
  markers: { g6: number; g7: number; g8: number; g9: number };
  /** g8/g9 列定义与预期不符时的说明(半残/未知结构 ⇒ unsupported,fail-closed)。 */
  anomalies: string[];
  rowCounts: { goal_messages: number; tasks: number };
}

/** 形状检测(只读;仅聚合与 information_schema,零原始数据)。 */
export async function detectMigrationShape(pool: pg.Pool | pg.PoolClient, schema: string): Promise<MigrationShape> {
  quoteIdent(schema); // 标识符合法性先行(非法 ⇒ 抛错,零查询)
  const s = schema;
  const r = await pool.query(
    `SELECT
       (SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_name='goal_messages') g6,
       (SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_name='goal_message_consumptions') g7,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='goal_messages' AND column_name='execution_request') g8,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='abort_requested_at') g9,
       (SELECT data_type || '/' || is_nullable || '/' || COALESCE(column_default,'(null)') FROM information_schema.columns WHERE table_schema=$1 AND table_name='goal_messages' AND column_name='execution_request') d8,
       (SELECT data_type || '/' || is_nullable || '/' || COALESCE(column_default,'(null)') FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='abort_requested_at') d9`,
    [s],
  );
  const row = r.rows[0] as Record<string, string>;
  const markers = { g6: Number(row["g6"]), g7: Number(row["g7"]), g8: Number(row["g8"]), g9: Number(row["g9"]) };
  const anomalies: string[] = [];
  if (markers.g8 === 1 && row["d8"] !== "boolean/NO/false") {
    anomalies.push(`0008 列定义与预期不符(goal_messages.execution_request=${row["d8"]};预期 boolean/NO/false)`);
  }
  if (markers.g9 === 1 && row["d9"] !== "timestamp with time zone/YES/(null)") {
    anomalies.push(`0009 列定义与预期不符(tasks.abort_requested_at=${row["d9"]};预期 timestamp with time zone/YES/(null))`);
  }
  // 行数聚合:基座表存在才查(表缺失时 PG 规划期即报错,CASE 无法短路 ⇒ 先判存在再查;-1=不存在)
  const rowCounts = { goal_messages: -1, tasks: -1 };
  if (markers.g6 === 1) {
    rowCounts.goal_messages = Number((await pool.query(`SELECT count(*) AS n FROM "${s}"."goal_messages"`)).rows[0]!["n"]);
  }
  if (markers.g6 === 1 || markers.g7 === 1) {
    const tasksTable = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name='tasks'`,
      [s],
    );
    if (Number(tasksTable.rows[0]!["n"]) === 1) {
      rowCounts.tasks = Number((await pool.query(`SELECT count(*) AS n FROM "${s}"."tasks"`)).rows[0]!["n"]);
    }
  }
  const appliedTags = REHEARSAL_RANGE.filter((e, i) => (i === 0 ? markers.g8 : markers.g9) === 1).map((e) => e.tag);
  const pendingTags = REHEARSAL_RANGE.filter((e, i) => (i === 0 ? markers.g8 : markers.g9) === 0).map((e) => e.tag);
  const supported = markers.g6 === 1 && markers.g7 === 1 && anomalies.length === 0;
  const verdict: MigrationShape["verdict"] = !supported
    ? "unsupported_shape"
    : pendingTags.length === 0
      ? "already_up_to_date"
      : "incremental_upgrade_available";
  return {
    schema,
    supported,
    verdict,
    appliedTags,
    pendingTags,
    markers,
    anomalies,
    // -1 = 基座表不存在(plan 对任意可读 schema 可用;apply 面由 supported=false 拒绝)
    rowCounts,
  };
}

export interface PlanStep {
  idx: number;
  tag: string;
  /** 真实迁移文件中的 SQL(注释块剔除;执行面与本工具 apply 一致)。 */
  statements: string[];
  precondition: { markerPresent: boolean; tablesPresent: boolean };
  postcondition: string[];
}

export interface MigrationPlan {
  schema: string;
  verdict: MigrationShape["verdict"];
  steps: PlanStep[];
  /** 回滚审批材料(生产执行须 D3;code 回退与 schema 回退边界见 D3 决策包)。 */
  rollbackNote: string;
}

/** 增量计划(SQL 一律取自真实迁移文件并载入 —— 已应用步骤同样展示 SQL 供审批材料对照)。 */
export async function buildIncrementalPlan(shape: MigrationShape): Promise<MigrationPlan> {
  const steps: PlanStep[] = REHEARSAL_RANGE.map((e, i) => {
    const markerPresent = (i === 0 ? shape.markers.g8 : shape.markers.g9) === 1;
    return {
      idx: e.idx,
      tag: e.tag,
      statements: [],
      precondition: {
        markerPresent,
        tablesPresent: i === 0 ? shape.markers.g6 === 1 : shape.markers.g6 === 1 && shape.markers.g7 === 1,
      },
      postcondition:
        i === 0
          ? [
              "goal_messages.execution_request 存在且为 boolean NOT NULL DEFAULT false",
              "既有 goal_messages 行 execution_request 全部回填 false(默认值语义)",
            ]
          : ["tasks.abort_requested_at 存在且为 timestamptz 可空(旧行 NULL)"],
    };
  });
  for (const step of steps) {
    step.statements = await migrationStatements(step.tag);
  }
  return {
    schema: shape.schema,
    verdict: shape.verdict,
    steps,
    rollbackNote:
      "代码回退:0008/0009 均为纯 ADD COLUMN(加列不删列),旧代码(不引用新列)与新 schema 兼容;" +
      "schema 回退:不自动 DROP COLUMN(会丢 0008 之后写入的数据),统一走备份恢复(deploy/backup.sh→restore-verify.sh)回到备份时点形状。",
  };
}

/**
 * 范围应用(测试/演练 fixture:精确构造 0000..toIdx 形状;**仅接受 p01a_ 前缀 schema**)。
 * 与 createIsolatedSchema 同语义(search_path 决定目标 + 末尾审计守卫),但按 idx 截断 ——
 * 用于在隔离 schema 上构造 0007 旧形状演练增量升级。
 */
export async function applyMigrationRange(
  client: pg.PoolClient,
  schema: string,
  toIdx: number,
): Promise<string[]> {
  if (!schema.startsWith(ALLOWED_SCHEMA_PREFIX)) {
    throw new Error(`范围应用拒绝:schema 必须以 ${ALLOWED_SCHEMA_PREFIX} 开头(得到 ${schema.slice(0, 8)}***)`);
  }
  const journal = await readJournal();
  const applied: string[] = [];
  await client.query(`SET search_path TO ${quoteIdent(schema)}`);
  for (const entry of journal.filter((e) => e.idx <= toIdx)) {
    const stmts = await migrationStatements(entry.tag);
    for (const stmt of stmts) {
      await client.query(stmt);
    }
    applied.push(entry.tag);
  }
  await client.query(AUDIT_APPEND_ONLY_GUARD);
  return applied;
}

export interface RehearsalStepReport {
  tag: string;
  status: "applied" | "skipped_already";
  statements: number;
}

export interface RehearsalReport {
  schema: string;
  target: string;
  startedAt: string;
  finishedAt: string | null;
  preVerdict: MigrationShape["verdict"];
  steps: RehearsalStepReport[];
  verification: { ok: boolean; failures: string[]; checks: Array<{ id: string; ok: boolean; detail: string }> };
  ok: boolean;
}

/**
 * 增量应用(apply 面唯一入口):
 *  1. assertApplyTargetAuthorized(p01a_/回环/显式端口;在任何写入前);
 *  2. 形状检测:unsupported(缺 0006/0007 基座或列定义异常)⇒ fail-closed 拒绝;
 *  3. 逐步事务:SET LOCAL search_path 钉死 → 标记检测(已应用 ⇒ skipped_already,不盲撞)→
 *     执行真实迁移 SQL → 事务内后验标记 → COMMIT;failAtTag 注入在到达该步时抛错
 *     (此前步骤已 COMMIT ⇒ 真实半迁移状态);
 *  4. 总后验(verifyPostMigrationState)⇒ 报告如实,不假 GO。
 */
export async function applyIncrementalMigration(
  pool: pg.Pool,
  schema: string,
  opts: { failAtTag?: string; url?: string } = {},
): Promise<RehearsalReport> {
  assertApplyTargetAuthorized(schema, opts.url ?? DEFAULT_TEST_DATABASE_URL);
  const startedAt = new Date().toISOString();
  const shape = await detectMigrationShape(pool, schema);
  if (!shape.supported) {
    throw new Error(
      `增量应用拒绝:schema ${sanitizeSchema(schema)} 形状不受支持(verdict=${shape.verdict}${shape.anomalies.length > 0 ? `;${shape.anomalies.join(";")}` : ""});` +
        "缺 0006/0007 基座或 0008/0009 列定义异常 ⇒ 未知结构不得自动升级(fail-closed)",
    );
  }
  const plan = await buildIncrementalPlan(shape);
  const client = await pool.connect();
  const steps: RehearsalStepReport[] = [];
  try {
    for (const step of plan.steps) {
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL search_path TO ${quoteIdent(schema)}`);
        // 标记检测(事务内;已应用 ⇒ 跳过,不盲撞)
        const marker = await client.query(
          step.idx === 8
            ? `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='goal_messages' AND column_name='execution_request'`
            : `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='abort_requested_at'`,
          [schema],
        );
        if (Number(marker.rows[0]!["n"]) === 1) {
          steps.push({ tag: step.tag, status: "skipped_already", statements: 0 });
          await client.query("COMMIT");
          continue;
        }
        if (opts.failAtTag === step.tag) {
          await client.query("ROLLBACK");
          throw new Error(`fail_at_injection:演练注入失败于 ${step.tag}(此前步骤已提交 ⇒ 真实半迁移状态)`);
        }
        for (const stmt of step.statements) {
          await client.query(stmt);
        }
        // 事务内后验:标记必须就位(否则回滚)
        const after = await client.query(
          step.idx === 8
            ? `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='goal_messages' AND column_name='execution_request'`
            : `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='abort_requested_at'`,
          [schema],
        );
        if (Number(after.rows[0]!["n"]) !== 1) {
          throw new Error(`step_postcondition_failed:${step.tag} 执行后标记缺失(事务回滚)`);
        }
        await client.query("COMMIT");
        steps.push({ tag: step.tag, status: "applied", statements: step.statements.length });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    }
  } finally {
    client.release();
  }
  const verification = await verifyPostMigrationState(pool, schema, { expectMarkers: { g6: 1, g7: 1, g8: 1, g9: 1 } });
  return {
    schema,
    target: sanitizeDbUrl(opts.url ?? DEFAULT_TEST_DATABASE_URL),
    startedAt,
    finishedAt: new Date().toISOString(),
    preVerdict: shape.verdict,
    steps,
    verification,
    ok: verification.ok,
  };
}

/** 后验(只读):列定义/默认值回填/append-only 触发器/FK 约束/形状标记。 */
export async function verifyPostMigrationState(
  pool: pg.Pool,
  schema: string,
  opts: { expectMarkers?: { g6: number; g7: number; g8: number; g9: number } } = {},
): Promise<RehearsalReport["verification"]> {
  const expect = opts.expectMarkers ?? { g6: 1, g7: 1, g8: 1, g9: 1 };
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  const push = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  // 逐项独立查询(每项单行单列)
  const scalar = async (q: string, params: string[] = []): Promise<string> => {
    const r = await pool.query(q, params);
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) return "0";
    return String(Object.values(row)[0]);
  };
  const s = schema;
  const g6 = Number(await scalar(`SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_name='goal_messages'`, [s]));
  push("marker_0006_goal_messages", g6 === expect.g6, `g6=${g6}(预期 ${expect.g6})`);
  const g7 = Number(await scalar(`SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_name='goal_message_consumptions'`, [s]));
  push("marker_0007_consumptions", g7 === expect.g7, `g7=${g7}(预期 ${expect.g7})`);
  const g8 = Number(await scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='goal_messages' AND column_name='execution_request'`, [s]));
  push("marker_0008_execution_request", g8 === expect.g8, `g8=${g8}(预期 ${expect.g8})`);
  const g9 = Number(await scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='abort_requested_at'`, [s]));
  push("marker_0009_abort_requested_at", g9 === expect.g9, `g9=${g9}(预期 ${expect.g9})`);
  if (g8 === 1) {
    const d8 = await scalar(`SELECT data_type || '/' || is_nullable || '/' || COALESCE(column_default,'(null)') FROM information_schema.columns WHERE table_schema=$1 AND table_name='goal_messages' AND column_name='execution_request'`, [s]);
    push("col_0008_definition", d8 === "boolean/NO/false", `定义=${d8}(预期 boolean/NO/false)`);
    const total = Number(await scalar(`SELECT count(*) FROM "${s}"."goal_messages"`));
    const falses = Number(await scalar(`SELECT count(*) FROM "${s}"."goal_messages" WHERE execution_request = false`));
    push("col_0008_default_backfill", falses === total, `旧行回填 false=${falses}/${total}`);
  }
  if (g9 === 1) {
    const d9 = await scalar(`SELECT data_type || '/' || is_nullable || '/' || COALESCE(column_default,'(null)') FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='abort_requested_at'`, [s]);
    push("col_0009_definition", d9 === "timestamp with time zone/YES/(null)", `定义=${d9}(预期 timestamp with time zone/YES/(null))`);
  }
  const trigAudit = Number(await scalar(`SELECT count(*) FROM information_schema.triggers WHERE trigger_schema=$1 AND event_object_table='audit_events'`, [s]));
  push(
    "guard_audit_triggers",
    trigAudit >= 2,
    `audit_events 触发器=${trigAudit}(≥2:audit_events_append_only/audit_events_no_truncate;缺失 ⇒ append-only 审计守卫受损)`,
  );
  const trigMsg = Number(await scalar(`SELECT count(*) FROM information_schema.triggers WHERE trigger_schema=$1 AND event_object_table='goal_messages'`, [s]));
  push("guard_goal_messages_append_only", trigMsg >= 1, `goal_messages 触发器=${trigMsg}(≥1)`);
  const trigCon = Number(await scalar(`SELECT count(*) FROM information_schema.triggers WHERE trigger_schema=$1 AND event_object_table='goal_message_consumptions'`, [s]));
  push("guard_consumptions_append_only", trigCon >= 1, `goal_message_consumptions 触发器=${trigCon}(≥1)`);
  const fks = Number(await scalar(`SELECT count(*) FROM information_schema.table_constraints WHERE table_schema=$1 AND table_name='goal_message_consumptions' AND constraint_type='FOREIGN KEY'`, [s]));
  push("fk_consumptions_intact", fks === 3, `consumptions FK=${fks}(预期 3)`);
  const failures = checks.filter((c) => !c.ok).map((c) => `${c.id}:${c.detail}`);
  return { ok: failures.length === 0, failures, checks };
}

function sanitizeSchema(schema: string): string {
  return RESERVED_SCHEMAS.has(schema) ? schema : `${schema.slice(0, 4)}***${schema.slice(-2)}`;
}

// ── CLI(plan/apply;演练入口唯一可执行面) ──

function renderPlan(plan: MigrationPlan, shape: MigrationShape, target: string): string {
  const lines: string[] = [];
  lines.push(`[rehearse-migration] 增量迁移计划(只读输出)target=${target} schema=${sanitizeSchema(shape.schema)}`);
  lines.push(`[rehearse-migration] 当前形状:verdict=${shape.verdict} markers=g6/g7/g8/g9=${shape.markers.g6}/${shape.markers.g7}/${shape.markers.g8}/${shape.markers.g9} 行数(goal_messages/tasks)=${shape.rowCounts.goal_messages}/${shape.rowCounts.tasks}`);
  if (shape.anomalies.length > 0) lines.push(`[rehearse-migration] 异常:${shape.anomalies.join(";")}`);
  for (const step of plan.steps) {
    lines.push(`[rehearse-migration] 步骤 idx=${step.idx} ${step.tag}${step.precondition.markerPresent ? " [已应用,跳过]" : " [待执行]"}`);
    for (const stmt of step.statements) lines.push(`    SQL> ${stmt.split("\n")[0]}`);
    for (const post of step.postcondition) lines.push(`    后验> ${post}`);
  }
  lines.push(`[rehearse-migration] 回滚材料>${plan.rollbackNote}`);
  lines.push("[rehearse-migration] 本输出为审批材料;生产执行(写 relay_console schema)必须用户单独 D3 授权,本工具永不直接执行。");
  return lines.join("\n");
}

const isMain = process.argv[1] !== undefined && process.argv[1]!.endsWith("rehearse-migration.ts");
if (isMain) {
  const args = process.argv.slice(2);
  const mode = args[0];
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const schema = flag("--schema") ?? "";
  const url = flag("--target-url") ?? DEFAULT_TEST_DATABASE_URL;
  const asJson = args.includes("--json");
  const outPath = flag("--out");
  const failAtTag = flag("--fail-at");
  try {
    if ((mode !== "plan" && mode !== "apply") || schema.length === 0) {
      console.error(
        "用法:node deploy/rehearsal 迁移演练\n" +
          "  node deploy/rehearse-migration.ts plan  --schema <schema> [--target-url <url>] [--json] [--out <file>]\n" +
          "  node deploy/rehearse-migration.ts apply --schema <p01a_*> [--target-url <url>] [--fail-at <tag>] [--json] [--out <file>]\n" +
          "说明:plan=只读形状检测+拟执行 SQL+前置/后置/回滚材料(生产 schema 只读允许);apply=仅 p01a_* 隔离测试 schema;生产执行须用户 D3。",
      );
      process.exit(2);
    }
    const target = sanitizeDbUrl(url);
    const writeOut = async (content: string): Promise<void> => {
      if (outPath) {
        // Reviewer Major-1 修复:--out 在 json/text 两态均落盘(此前仅 --json 分支生效 ⇒ 证据悬空)
        await (await import("node:fs/promises")).writeFile(outPath, content.endsWith("\n") ? content : content + "\n");
        console.error(`[rehearse-migration] 已写出:${outPath}`);
      } else {
        process.stdout.write(content.endsWith("\n") ? content : content + "\n");
      }
    };
    if (mode === "plan") {
      quoteIdent(schema); // 标识符校验(只读;非法 ⇒ 拒绝)
      const pool = new pg.Pool({ connectionString: url, max: 2 });
      try {
        const shape = await detectMigrationShape(pool, schema);
        const plan = await buildIncrementalPlan(shape);
        if (asJson) {
          await writeOut(JSON.stringify({ mode, target, shape, plan, note: "只读审批材料;生产执行须用户 D3" }, null, 2));
        } else {
          await writeOut(renderPlan(plan, shape, target));
        }
        process.exit(shape.supported ? 0 : 2);
      } finally {
        await pool.end().catch(() => {});
      }
    } else {
      // apply:守卫在任何连接之前(保留 schema/非 p01a_/非回环/未显式端口 ⇒ 拒绝,零写入)
      assertApplyTargetAuthorized(schema, url);
      const pool = new pg.Pool({ connectionString: url, max: 2 });
      try {
        const report = await applyIncrementalMigration(pool, schema, { ...(failAtTag ? { failAtTag } : {}), url });
        await writeOut(JSON.stringify(report, null, 2));
        process.exit(report.ok ? 0 : 1);
      } finally {
        await pool.end().catch(() => {});
      }
    }
  } catch (err) {
    // Reviewer Minor-1 修复:措辞与真实状态一致 —— 守卫拒绝发生在任何连接前(零写入);
    // 执行中失败(如 fail-at 注入)此前步骤可能已提交 ⇒ 以断点为准,不得宣称"零写入"
    console.error(`[rehearse-migration] 失败(fail-closed):${err instanceof Error ? err.message : String(err)}`);
    console.error("[rehearse-migration] 说明:目标/参数拒绝=任何连接前零写入;执行中失败=此前步骤可能已提交(真实半迁移),复跑 plan 定位断点,绝不假 GO。");
    process.exit(2);
  }
}
