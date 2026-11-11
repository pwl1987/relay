// 备份 Artifact 清单(跨 schema 聚合已交付候选;阶段 E3)
import { writeFileSync } from "node:fs";
import pg from "pg";

const out = process.argv[3] ?? process.argv[2];
const pool = new pg.Pool({ connectionString: process.env.RELAY_DB_URL });
const schemas = (await pool.query("SELECT table_schema FROM information_schema.tables WHERE table_name='candidate_changesets'")).rows.map((r) => r.table_schema);
const manifest = [];
for (const sch of schemas) {
  const q = `SELECT id, task_id, git_commit_sha, delivered_remote_head, delivery_state, changed_files FROM "${sch}".candidate_changesets WHERE delivery_state = 'DELIVERED'`;
  const r = await pool.query(q);
  manifest.push(
    ...r.rows.map((x) => ({ schema: sch, changesetId: x.id, taskId: x.task_id, commit: x.git_commit_sha, remoteHead: x.delivered_remote_head, files: x.changed_files })),
  );
}
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), delivered: manifest }, null, 2));
console.log(`[backup] artifacts manifest: ${manifest.length} 个已交付变更集(跨 ${schemas.length} schema)`);
await pool.end();
