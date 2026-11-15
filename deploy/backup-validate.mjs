// RELAY-BACKUP-INTEGRITY-09:备份/恢复目标校验(fail-closed 单一入口)。
// backup.sh 步骤0 与 backup-manifest.mjs 共用语义:仅读 information_schema 元数据(零原始数据查询);
// 校验失败 exit 2,消息脱敏(零密码),绝不生成任何 dump/manifest 产物。
// 语义:未声明目标 schema ⇒ 拒绝(拒绝静默整库);目标不存在/缺少 Relay 表(candidate_changesets/
// audit_events)⇒ 拒绝(归属不能确认);all = 显式旧版整库兼容模式(仍要求合法 RELAY_DB_URL)。
import pg from "pg";

/** schema 标识符白名单:防注入/防歧义(归属由存在性检查承担;名字合法≠可备份)。 */
export function isValidRelaySchemaName(s) {
  return typeof s === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

/** 连接串脱敏:密码替换为 ***(日志/错误零密码)。 */
export function redactDbUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable-db-url)";
  }
}

/** 校验备份目标:返回 { ok:true } 或 { ok:false, reason };绝不抛出(调用方按结果 fail-closed)。 */
export async function validateBackupTarget(schema, url, pgModule = pg) {
  if (!url) return { ok: false, reason: "RELAY_DB_URL 未设置;拒绝备份" };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `RELAY_DB_URL 不是合法 URL(${redactDbUrl(url)});拒绝备份` };
  }
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!dbName) return { ok: false, reason: `RELAY_DB_URL 缺少库名(${redactDbUrl(url)});拒绝备份` };
  if (schema === "all") return { ok: true, dbName };
  if (!isValidRelaySchemaName(schema))
    return { ok: false, reason: `目标 schema 名非法(须 ^[A-Za-z_][A-Za-z0-9_]*$,实际=${JSON.stringify(schema)});拒绝备份` };
  const pool = new pgModule.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const r = await pool.query(
      `SELECT (SELECT count(*)::int FROM information_schema.schemata WHERE schema_name = $1) AS schema_exists,
              (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'candidate_changesets') AS has_changesets,
              (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'audit_events') AS has_audit`,
      [schema],
    );
    const row = r.rows[0];
    if (!row || Number(row.schema_exists) === 0)
      return { ok: false, reason: `目标 schema 不存在:${schema}(连接目标=${redactDbUrl(url)});拒绝备份` };
    if (Number(row.has_changesets) === 0 || Number(row.has_audit) === 0)
      return {
        ok: false,
        reason: `目标 schema 缺少 Relay 表(candidate_changesets/audit_events):${schema};归属不能确认,拒绝备份`,
      };
    return { ok: true, dbName };
  } catch (err) {
    return {
      ok: false,
      reason: `目标校验连接失败(未生成任何产物):${err instanceof Error ? err.message : String(err)}(${redactDbUrl(url)})`,
    };
  } finally {
    await pool.end().catch(() => {});
  }
}

const isMain = typeof process.argv[1] === "string" && process.argv[1].endsWith("backup-validate.mjs");
if (isMain) {
  const schema = process.argv[2];
  if (!schema) {
    console.error("[backup-validate] fail-closed:未声明目标 schema(目标 Relay schema 或 all);拒绝静默整库");
    process.exit(2);
  }
  const result = await validateBackupTarget(schema, process.env.RELAY_DB_URL);
  if (!result.ok) {
    console.error(`[backup-validate] fail-closed:${result.reason}`);
    process.exit(2);
  }
  console.log(`[backup-validate] 目标=${schema === "all" ? "all(显式旧版整库兼容模式)" : schema} 校验通过`);
}
