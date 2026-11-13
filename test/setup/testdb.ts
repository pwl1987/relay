// 测试数据库隔离:每个测试文件创建独立 schema,应用完整迁移,结束即删。
// 满足 p0-00 REPORT §8.6 建议("各实验应使用独立 schema/database")与全新克隆复现要求。
// RELAY-SAFETY-CLOSE-02 P0-C:测试库授权守卫(fail-closed)——
//   1. 目标必须是授权的独立测试三元组(loopback:55433/relayp000;scripts/test-db-up.sh 容器),
//      错误生产 URL 在**任何连接/写操作之前**被拒绝(不是仅凭 TCP 可达即认定安全);
//   2. 测试 schema 钉死 p01a_ 前缀(生产 relay_console 与测试共享同一 PG 实例,仅 schema
//      隔离 —— 2026-11-13 只读核实;测试永不触碰 relay_console 或其它 schema);
//   3. 连接串密码零打印:一切错误消息经 redactDbUrl 脱敏。
import pg from "pg";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { sql } from "drizzle-orm";
import {
  connectDb,
  createIsolatedSchema,
  DEFAULT_TEST_DATABASE_URL,
  dropSchema,
  type RelayDb,
} from "../../src/core/db.ts";

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../migrations");

/** 授权测试库三元组(与 scripts/test-db-up.sh 容器一致;确定性规则,无环境变量逃逸口)。 */
export const AUTHORIZED_TEST_DB = {
  hosts: new Set(["127.0.0.1", "localhost", "::1"]),
  port: "55433",
  database: "relayp000",
} as const;

/** 连接串脱敏:密码替换为 ***(日志/错误消息零密码;P0-C)。 */
export function redactDbUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable-db-url)";
  }
}

/**
 * 测试库授权守卫(P0-C,fail-closed):目标不是授权三元组 ⇒ 同步抛错,
 * 调用方(new pg.Pool / CREATE SCHEMA)尚未执行 ⇒ 任何连接与写操作都不会发生。
 * 生产 RELAY_DB_URL(worker-entry/server 使用)不受本守卫约束;本守卫只管测试面。
 */
export function assertAuthorizedTestDatabaseUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`测试库守卫拒绝:RELAY_DB_URL 不是合法 URL(${redactDbUrl(url)});未执行任何连接或写操作`);
  }
  const port = u.port || "5432";
  const ok =
    AUTHORIZED_TEST_DB.hosts.has(u.hostname) &&
    port === AUTHORIZED_TEST_DB.port &&
    u.pathname.replace(/^\//, "") === AUTHORIZED_TEST_DB.database;
  if (!ok) {
    throw new Error(
      `测试库守卫拒绝:测试只允许授权的独立测试库(${AUTHORIZED_TEST_DB.hosts.has("127.0.0.1") ? "127.0.0.1|localhost|::1" : ""}:${AUTHORIZED_TEST_DB.port}/${AUTHORIZED_TEST_DB.database});` +
        `当前目标 ${redactDbUrl(url)} 不在授权范围,未执行任何连接或写操作(生产 RELAY_DB_URL 不得用于测试)`,
    );
  }
}

export interface TestDb {
  db: RelayDb;
  pool: pg.Pool;
  adminPool: pg.Pool;
  schemaName: string;
  url: string;
  cleanup(): Promise<void>;
}

export function databaseUrl(): string {
  return process.env.RELAY_DB_URL ?? DEFAULT_TEST_DATABASE_URL;
}

export async function createTestDb(label: string): Promise<TestDb> {
  const url = databaseUrl();
  // 授权守卫:在建立任何连接之前执行(错误生产 URL ⇒ fail-closed,零连接零写入)
  assertAuthorizedTestDatabaseUrl(url);
  const adminPool = new pg.Pool({ connectionString: url, max: 4 });
  try {
    await adminPool.query("SELECT 1");
  } catch (err) {
    await adminPool.end().catch(() => {});
    throw new Error(
      `RELAY 测试库不可达(${redactDbUrl(url)});全新复现请先运行 \`npm run db:up\` 启动测试 PG。原始错误: ${String(err)}`,
    );
  }
  const schemaName = `p01a_${sanitize(label)}_${randomUUID().slice(0, 8)}`;
  // schema 前缀守卫(P0-C):测试 schema 钉死 p01a_(与生产 relay_console 空间隔离;
  // 防御未来重构误传外部 schema 名 —— 直接 fail-closed,不进入 CREATE/DROP)
  if (!/^p01a_/.test(schemaName))
    throw new Error(`测试库守卫拒绝:测试 schema 必须以 p01a_ 开头(得到 ${schemaName.slice(0, 8)}***)`);
  await createIsolatedSchema(adminPool, schemaName, MIGRATIONS_DIR);
  const { pool, db } = connectDb(url, schemaName);
  return {
    db,
    pool,
    adminPool,
    schemaName,
    url,
    async cleanup() {
      await pool.end().catch(() => {});
      await dropSchema(adminPool, schemaName);
      await adminPool.end();
    },
  };
}

function sanitize(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "x"
  );
}

// 常用断言辅助:直接查询任务状态(绕过领域层,保证验证独立性)
export async function taskState(db: RelayDb, taskId: string): Promise<Record<string, unknown>> {
  const res = await db.execute(
    sql`SELECT id, state, state_version, attempt, max_attempts, blocked_reason FROM tasks WHERE id = ${taskId}`,
  );
  if (res.rows.length === 0) throw new Error(`task not found: ${taskId}`);
  return res.rows[0]!;
}

export async function auditActions(db: RelayDb, taskId?: string): Promise<Array<Record<string, unknown>>> {
  const res = taskId
    ? await db.execute(
        sql`SELECT seq, actor, authority, action, before_state, after_state, detail FROM audit_events WHERE task_id = ${taskId} ORDER BY seq`,
      )
    : await db.execute(
        sql`SELECT seq, actor, authority, action, before_state, after_state, detail FROM audit_events ORDER BY seq`,
      );
  return res.rows;
}

// 独立播种任务(绕过领域层):直接 INSERT READY 任务
export async function seedTask(
  db: RelayDb,
  spec: {
    id: string;
    priority?: number;
    allowedScope?: string[];
    gateRequired?: boolean;
    maxAttempts?: number;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO tasks (id, state, priority, allowed_scope, gate_required, max_attempts)
    VALUES (${spec.id}, 'READY', ${spec.priority ?? 0},
      ${JSON.stringify(spec.allowedScope ?? [])}::jsonb,
      ${spec.gateRequired ?? true}, ${spec.maxAttempts ?? 3})
  `);
}
