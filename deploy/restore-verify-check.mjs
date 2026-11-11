// 恢复核对(跨 schema 聚合;阶段 E3)
import { readFileSync } from "node:fs";
import pg from "pg";

const m = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pool = new pg.Pool({ connectionString: process.env.RESTORE_TARGET_URL });
const schemas = (await pool.query("SELECT table_schema FROM information_schema.tables WHERE table_name='candidate_changesets'")).rows.map((r) => r.table_schema);
let restored = 0;
for (const sch of schemas) {
  const r = await pool.query(`SELECT count(*)::int AS n FROM "${sch}".candidate_changesets WHERE delivery_state = 'DELIVERED'`);
  restored += r.rows[0].n;
}
const expected = m.delivered.length;
console.log(`[restore] 交付记录:备份 manifest=${expected} 恢复后=${restored}${expected === restored ? " 一致 ✓" : " 不一致 ✗"}`);
const idx = await pool.query("SELECT table_schema FROM information_schema.tables WHERE table_name='audit_events'");
let audits = 0;
for (const row of idx.rows) {
  const sch = row.table_schema;
  const r = await pool.query(`SELECT count(*)::int AS n FROM "${sch}".audit_events`);
  audits += r.rows[0].n;
}
console.log(`[restore] 审计行(全 schema 合计):${audits}`);
await pool.end();
if (expected !== restored) process.exit(1);
