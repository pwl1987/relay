// 测试数据库隔离:每个测试文件创建独立 schema,应用完整迁移,结束即删。
// 满足 p0-00 REPORT §8.6 建议("各实验应使用独立 schema/database")与全新克隆复现要求。
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
  const adminPool = new pg.Pool({ connectionString: url, max: 4 });
  try {
    await adminPool.query("SELECT 1");
  } catch (err) {
    await adminPool.end().catch(() => {});
    throw new Error(
      `RELAY 测试库不可达(${url});全新复现请先运行 \`npm run db:up\` 启动测试 PG。原始错误: ${String(err)}`,
    );
  }
  const schemaName = `p01a_${sanitize(label)}_${randomUUID().slice(0, 8)}`;
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
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "x";
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
    ? await db.execute(sql`SELECT seq, actor, authority, action, before_state, after_state, detail FROM audit_events WHERE task_id = ${taskId} ORDER BY seq`)
    : await db.execute(sql`SELECT seq, actor, authority, action, before_state, after_state, detail FROM audit_events ORDER BY seq`);
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
