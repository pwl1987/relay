// 备份 Artifact 清单(RELAY-BACKUP-INTEGRITY-09:只认显式声明目标 schema;阶段 E3 all=显式旧版聚合)。
// 未声明 RELAY_BACKUP_SCHEMA ⇒ fail-closed 拒绝(拒绝静默跨 schema 聚合);目标 schema 不存在/
// 缺 candidate_changesets ⇒ 拒绝(归属不能确认);manifest 记录 targetSchema=恢复核对的目标身份唯一来源。
import { writeFileSync } from "node:fs";
import pg from "pg";

const out = process.argv[3] ?? process.argv[2];
if (!out) {
  console.error("[backup] fail-closed:缺少 manifest 输出路径(argv);拒绝");
  process.exit(2);
}
const schema = process.env.RELAY_BACKUP_SCHEMA;
if (!schema) {
  console.error(
    "[backup] fail-closed:未声明 RELAY_BACKUP_SCHEMA(目标 Relay schema 或 all);拒绝生成 manifest(拒绝静默跨 schema 聚合)",
  );
  process.exit(2);
}
if (schema !== "all" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
  console.error(`[backup] fail-closed:目标 schema 名非法(实际=${JSON.stringify(schema)});拒绝`);
  process.exit(2);
}
if (!process.env.RELAY_DB_URL) {
  console.error("[backup] fail-closed:RELAY_DB_URL 未设置;拒绝");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: process.env.RELAY_DB_URL, max: 2, connectionTimeoutMillis: 10_000 });
let schemas;
try {
  if (schema === "all") {
    schemas = (
      await pool.query("SELECT table_schema FROM information_schema.tables WHERE table_name='candidate_changesets' ORDER BY 1")
    ).rows.map((r) => r.table_schema);
  } else {
    // 只认目标 schema:存在性 + Relay 表归属(与 backup-validate 同语义,manifest 阶段二次校验)
    const chk = await pool.query(
      `SELECT (SELECT count(*)::int FROM information_schema.schemata WHERE schema_name=$1) AS s,
              (SELECT count(*)::int FROM information_schema.tables WHERE table_schema=$1 AND table_name='candidate_changesets') AS c`,
      [schema],
    );
    const row = chk.rows[0];
    if (!row || Number(row.s) === 0) {
      console.error(`[backup] fail-closed:目标 schema 不存在:${schema};拒绝生成 manifest`);
      process.exit(2);
    }
    if (Number(row.c) === 0) {
      console.error(`[backup] fail-closed:目标 schema 缺少 candidate_changesets:${schema};归属不能确认,拒绝`);
      process.exit(2);
    }
    schemas = [schema];
  }
} catch (err) {
  console.error(`[backup] fail-closed:manifest 目标校验失败(schema=${schema},未生成任何产物):${err instanceof Error ? err.message : String(err)}`);
  await pool.end().catch(() => {});
  process.exit(2);
}
const manifest = [];
for (const sch of schemas) {
  const q = `SELECT id, task_id, git_commit_sha, delivered_remote_head, delivery_state, changed_files FROM "${sch}".candidate_changesets WHERE delivery_state = 'DELIVERED' ORDER BY id`;
  const r = await pool.query(q);
  manifest.push(
    ...r.rows.map((x) => ({ schema: sch, changesetId: x.id, taskId: x.task_id, commit: x.git_commit_sha, remoteHead: x.delivered_remote_head, files: x.changed_files })),
  );
}
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), targetSchema: schema, delivered: manifest }, null, 2));
console.log(`[backup] artifacts manifest: ${manifest.length} 个已交付变更集(schema=${schema === "all" ? `跨 ${schemas.length} schema(显式 all)` : schema})`);
await pool.end();
