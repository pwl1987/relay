// WEB-UX-01 阶段六(VM80 Console 部署)· schema 初始化(幂等;仅部署时手工运行)。
// 用法:node deploy/init-schema.ts <schemaName>
//  - RELAY_DB_URL 缺省同 src/core/db.ts(postgresql://…@127.0.0.1:55433/relayp000)
//  - 已存在 goals 表 ⇒ 跳过迁移(幂等);否则 createIsolatedSchema(含 append-only 审计守卫)
//  - 不触碰 soak24h 或任何 p01a_* 测试 schema
import pg from "pg";
import { connectDb, createIsolatedSchema, dropSchema } from "../src/core/db.ts";
import { MIGRATIONS_DIR } from "../test/setup/testdb.ts";

const schemaName = process.argv[2] ?? "";
if (!schemaName || !/^[a-z_][a-z0-9_]*$/i.test(schemaName)) {
  console.error("用法:node deploy/init-schema.ts <schemaName>(合法标识符)");
  process.exit(1);
}

const url = process.env.RELAY_DB_URL || "postgresql://postgres:relayp000local@127.0.0.1:55433/relayp000";
const adminPool = new pg.Pool({ connectionString: url, max: 2 });
try {
  const exists = await adminPool.query(
    `SELECT to_regclass($1) AS t`,
    [`${schemaName}.goals`],
  );
  if (exists.rows[0] && exists.rows[0]["t"]) {
    console.log(`[init-schema] schema ${schemaName} 已存在(goals 表在),跳过迁移(幂等)`);
  } else {
    const applied = await createIsolatedSchema(adminPool, schemaName, MIGRATIONS_DIR);
    console.log(`[init-schema] schema ${schemaName} 已创建并应用 ${applied.length} 个迁移`);
  }
  const audit = await adminPool.query(`SELECT count(*)::int AS n FROM ${schemaName}.audit_events`);
  console.log(`[init-schema] audit_events 行数=${audit.rows[0]!["n"]}`);
} catch (err) {
  console.error(`[init-schema] 失败:${err instanceof Error ? err.message : String(err)}`);
  await adminPool.end().catch(() => {});
  process.exit(1);
} finally {
  await adminPool.end().catch(() => {});
}
void dropSchema; // 仅导出复用;本脚本不删除任何 schema
