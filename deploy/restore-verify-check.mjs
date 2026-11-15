// 恢复核对(RELAY-BACKUP-INTEGRITY-09:目标身份 + 稳定键集合核对,不只计数;阶段 E3 all=显式旧版聚合)。
// 用法:node restore-verify-check.mjs <manifest.json> <audit-index.txt>(env RESTORE_TARGET_URL)
// 判据(任一不满足 ⇒ exit≠0):
//   ① manifest 合法且含 targetSchema(legacy/损坏 manifest 一律拒绝);
//   ② 目标 schema 在恢复库存在(all=聚合全部 Relay schema);
//   ③ DELIVERED 集合身份相等(schema/changesetId/taskId/commit/remoteHead——相同计数不构成通过);
//   ④ 审计索引集合相等(seq|ts|actor|action,与 backup.sh 步骤3 同表达式;错源/丢失/混入即拒绝)。
import { readFileSync } from "node:fs";
import pg from "pg";

const manifestPath = process.argv[2];
const auditIndexPath = process.argv[3];
if (!manifestPath || !auditIndexPath) {
  console.error("[restore] fail-closed:用法 restore-verify-check.mjs <manifest> <audit-index.txt>(env RESTORE_TARGET_URL)");
  process.exit(2);
}
if (!process.env.RESTORE_TARGET_URL) {
  console.error("[restore] fail-closed:RESTORE_TARGET_URL 未设置;拒绝");
  process.exit(2);
}
let m;
try {
  m = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (err) {
  console.error(`[restore] fail-closed:manifest 不可读/非 JSON(${err instanceof Error ? err.message : String(err)});拒绝`);
  process.exit(2);
}
if (!m || typeof m !== "object" || !Array.isArray(m.delivered) || typeof m.targetSchema !== "string" || m.targetSchema === "") {
  console.error("[restore] fail-closed:manifest 缺少 targetSchema/delivered(legacy 或损坏);拒绝核对");
  process.exit(2);
}
const target = m.targetSchema;
if (target !== "all" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) {
  console.error(`[restore] fail-closed:manifest.targetSchema 非法(${JSON.stringify(target)});拒绝`);
  process.exit(2);
}

/** DELIVERED 行稳定键(不含 files jsonb —— 键序不稳定;保真由 pg_dump/恢复面与 E2E 摘要承担)。 */
const identity = (d) => JSON.stringify([d.schema, d.changesetId, d.taskId, d.commit, d.remoteHead ?? null]);

const pool = new pg.Pool({ connectionString: process.env.RESTORE_TARGET_URL, max: 2, connectionTimeoutMillis: 10_000 });
let fail = "";
try {
  const schQ =
    target === "all"
      ? (await pool.query("SELECT DISTINCT table_schema FROM information_schema.tables WHERE table_name='candidate_changesets' ORDER BY 1")).rows.map((r) => r.table_schema)
      : Number((await pool.query("SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name=$1", [target])).rows[0].n) > 0
        ? [target]
        : [];
  if (schQ.length === 0) {
    fail = `恢复库中目标 schema 不存在:${target}(目标身份不符)`;
  } else {
    // ① DELIVERED 集合身份
    const restored = [];
    for (const sch of schQ) {
      const r = await pool.query(
        `SELECT $1::text AS schema, id, task_id, git_commit_sha, delivered_remote_head FROM "${sch}".candidate_changesets WHERE delivery_state = 'DELIVERED' ORDER BY id`,
        [sch],
      );
      restored.push(...r.rows.map((x) => ({ schema: x.schema, changesetId: x.id, taskId: x.task_id, commit: x.git_commit_sha, remoteHead: x.delivered_remote_head })));
    }
    const expected = [...m.delivered].map(identity).sort();
    const actual = [...restored].map(identity).sort();
    const deliveredOk = expected.length === actual.length && expected.every((v, i) => v === actual[i]);
    console.log(`[restore] 交付记录:manifest=${expected.length} 恢复后=${actual.length}${deliveredOk ? " 集合身份一致 ✓" : " 集合身份不一致 ✗"}`);
    if (!deliveredOk) {
      const onlyM = expected.filter((v) => !actual.includes(v)).slice(0, 1);
      const onlyR = actual.filter((v) => !expected.includes(v)).slice(0, 1);
      console.log(`[restore]   仅在 manifest 样例:${onlyM.length > 0 ? JSON.stringify(onlyM[0]) : "-"};仅在恢复库样例:${onlyR.length > 0 ? JSON.stringify(onlyR[0]) : "-"}`);
      fail = fail || "DELIVERED 集合身份不一致(相同计数不构成通过)";
    }
    // ② 审计索引集合身份(seq|ts|actor|action;与 backup.sh 步骤3 同表达式,服务端拼接保证格式一致;
    //    all 模式按 audit_events 表存在性聚合 —— 与 backup.sh all 枚举同源,含非 Relay schema 如 public 遗留)
    const auditSchemas =
      target === "all"
        ? (
            await pool.query(
              "SELECT DISTINCT table_schema FROM information_schema.tables WHERE table_name='audit_events' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1",
            )
          ).rows.map((r) => r.table_schema)
        : schQ;
    const indexLines = readFileSync(auditIndexPath, "utf8")
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    const auditRows = [];
    for (const sch of auditSchemas) {
      const r = await pool.query(`SELECT seq || '|' || ts || '|' || actor || '|' || action AS line FROM "${sch}".audit_events ORDER BY seq`, []);
      auditRows.push(...r.rows.map((x) => x.line));
    }
    const expectedA = [...indexLines].sort();
    const actualA = [...auditRows].sort();
    const auditOk = expectedA.length === actualA.length && expectedA.every((v, i) => v === actualA[i]);
    console.log(`[restore] 审计索引:备份=${expectedA.length} 行 恢复后=${actualA.length} 行(schema=${target === "all" ? `聚合 ${auditSchemas.length} schema(显式 all)` : target})${auditOk ? " 集合一致 ✓" : " 集合不一致 ✗"}`);
    if (!auditOk) fail = fail || "审计索引集合不一致(错源/丢失/混入)";
  }
} catch (err) {
  fail = fail || `恢复核对连接失败:${err instanceof Error ? err.message : String(err)}`;
} finally {
  await pool.end().catch(() => {});
}
if (fail) {
  console.error(`[restore] fail-closed:${fail}`);
  process.exit(1);
}
console.log("[restore] 核对通过:目标身份 + 交付集合身份 + 审计索引集合 全部一致");
