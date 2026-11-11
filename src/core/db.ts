// 数据库连接与迁移应用。测试通过独立 schema 隔离(REPORT §8.6 建议的落地)。
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { SQL } from "drizzle-orm";
import * as schema from "./schema.ts";

export const DEFAULT_TEST_DATABASE_URL =
  process.env.RELAY_DB_URL ?? "postgresql://postgres:relayp000local@127.0.0.1:55433/relayp000";

export type RelayDb = NodePgDatabase<typeof schema>;

// 事务内执行器:db(自动提交)或 tx(事务)都满足该结构。
export interface Exec {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface DbHandle {
  pool: pg.Pool;
  db: RelayDb;
}

export function connectDb(url: string = DEFAULT_TEST_DATABASE_URL, searchPath?: string): DbHandle {
  const pool = new pg.Pool({
    connectionString: url,
    ...(searchPath ? { options: `-c search_path=${searchPath}` } : {}),
  });
  // P0-ACCEPT 缺口 E 收口:PG 断连必须"可见降级"而非进程崩溃(SECURITY_MODEL §5:数据库不可用 ⇒
  // 停止新写执行/拒绝状态推进,恢复后自愈)。空闲连接被服务端断开时 Pool 发 'error' 事件,
  // 无监听即 unhandled ⇒ uncaughtException ⇒ 进程死(E 演练实测:docker stop PG ⇒ relay-server 崩溃)。
  // 监听后:记录 stderr,后续请求经 health/tick 的 SQL 失败自然降级;PG 恢复后连接池自愈。
  pool.on("error", (err: Error) => {
    console.error(`[relay-db] pool idle client error(不崩进程;等待 PG 恢复后自愈):${err.message}`);
  });
  return { pool, db: drizzle(pool, { schema }) };
}

export async function closeDb(handle: DbHandle): Promise<void> {
  await handle.pool.end();
}

// audit_events append-only 守卫(NFR-02:动作日志不可无痕改写)。
// 以幂等 SQL 在每次迁移应用后确保存在;不进入 drizzle journal
// ⇒ 部署必须使用 applyMigrations(db.ts),不得裸跑 drizzle-kit migrate(否则守卫缺失)。
// UPDATE/DELETE 走行级触发器;TRUNCATE 走语句级触发器(行级触发器不拦 TRUNCATE)。
export const AUDIT_APPEND_ONLY_GUARD = `
CREATE OR REPLACE FUNCTION relay_forbid_audit_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP;
END;
$fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION relay_forbid_audit_mutation();
DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION relay_forbid_audit_mutation();
`;

interface JournalEntry {
  tag: string;
}

// 依序执行 drizzle-kit 生成的迁移(meta/_journal.json 为序),然后应用 append-only 守卫。
export async function applyMigrations(
  client: pg.Client | pg.Pool,
  migrationsDir: string,
): Promise<string[]> {
  const journalPath = path.join(migrationsDir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: JournalEntry[];
  };
  const applied: string[] = [];
  for (const entry of journal.entries) {
    const file = path.join(migrationsDir, `${entry.tag}.sql`);
    const raw = await readFile(file, "utf8");
    // drizzle-kit 生成的 FK 会硬编码 "public". 限定;剥离后由 search_path 决定目标 schema
    // (每测试独立 schema 隔离依赖此语义;迁移文件本身也已去除该限定)
    const normalized = raw.replaceAll('"public".', '"');
    for (const stmt of normalized.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed.length > 0) await client.query(trimmed);
    }
    applied.push(entry.tag);
  }
  await client.query(AUDIT_APPEND_ONLY_GUARD);
  return applied;
}

// 测试隔离:创建全新 schema 并应用迁移;返回清理函数。
// 每个 Vitest 文件(或每次全新复现)调用一次,保证互不污染。
export async function createIsolatedSchema(
  pool: pg.Pool,
  schemaName: string,
  migrationsDir: string,
): Promise<string[]> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${quoteIdent(schemaName)}`);
    return await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
}

export async function dropSchema(pool: pg.Pool, schemaName: string): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)} CASCADE`);
}

export async function migrationFiles(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith(".sql")).map((e) => e.name).sort();
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`invalid schema identifier: ${name}`);
  }
  return `"${name}"`;
}
