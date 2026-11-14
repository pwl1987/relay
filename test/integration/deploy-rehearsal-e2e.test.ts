// RELAY-DEPLOY-REHEARSAL-08 D 项:隔离备份 → 增量迁移 → 恢复回退边界演练(真实 docker,零生产触碰)。
// 流程(全部在一次性 postgres:17-alpine 容器内;容器名 relay-test-d08-* sentinel,退出即删):
//   1) 建 p01a_d08e2e_* schema 并精确构造 0007 旧形状 + 最小合成行(含中文/jsonb 保真 + DELIVERED 候选);
//   2) 备份:与 deploy/backup.sh 步骤1同命令形态(docker exec <实例> pg_dump --no-owner --no-privileges <库>)
//      + 跨 schema 交付 manifest(复用 deploy/backup-manifest.mjs)+ schema 限定审计索引 + sha256 校验和
//      (backup.sh 审计索引回退硬编码 relay-p000-pg/relayp000 且未限定 schema —— 登记 F-1,见 REPORT);
//   3) 迁移:真实演练工具 applyIncrementalMigration 0007→0009 + 后验 + 代码回退兼容 INSERT
//      (旧行为 INSERT 不引用新列 ⇒ 成功且默认回填 false —— "代码回退兼容新增列"实证);
//   4) 恢复:同一实例内新建 relay_restore_v* 库导入备份(restore-verify.sh 容器路径同形态)+
//      复用 deploy/restore-verify-check.mjs 交叉核对(真实脚本);
//   5) 回退边界断言:恢复库形状=0007(0008/0009 标记缺失)+ 合成行逐条保真 + 触发器/FK 完好
//      —— "schema 回退=回到备份时点形状,不自动 DROP COLUMN"的实证。
// 门:skipIf(!docker);CI runner 具备 docker(egress E2E 同门实证),无宿主 psql 依赖。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { dockerAvailable } from "../../src/runtime/sandbox.ts";
import { markTemp, safeRm, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";
import {
  applyIncrementalMigration,
  applyMigrationRange,
  verifyPostMigrationState,
} from "../../deploy/rehearse-migration.ts";

const dockerOk = dockerAvailable();
console.log(`[d08-e2e 门控] docker=${dockerOk}`);
const TIMEOUT = 300_000;

describe.skipIf(!dockerOk)("RELAY-DEPLOY-REHEARSAL-08:隔离备份→增量迁移→恢复回退(一次性 PG 容器)", () => {
  const uid = randomUUID().slice(0, 8);
  const container = `relay-test-d08-${uid}`;
  const schemaName = `p01a_d08e2e_${uid}`;
  const restoreDb = `relay_restore_v${Math.floor(Date.now() / 1000)}`;
  let tmpRoot = "";
  let dbPassword = "";
  let mainPort = "";
  let mainUrl = "";
  let restoreUrl = "";
  let admin: pg.Pool | null = null;

  const dexec = (args: string[], opts: { input?: string; maxBuffer?: number; stdin?: boolean } = {}): string =>
    execFileSync("docker", ["exec", ...(opts.stdin ? ["-i"] : []), container, ...args], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });

  beforeAll(async () => {
    tmpRoot = markTemp(mkdtempSync(join(tmpdir(), "d08-e2e-")));
    dbPassword = `d08-${uid}`;
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        container,
        "-e",
        `POSTGRES_PASSWORD=${dbPassword}`,
        "-e",
        "POSTGRES_DB=relayd08",
        "-P",
        "postgres:17-alpine",
      ],
      { timeout: 120_000 },
    );
    // 端口映射(随机宿主端口;仅绑定 0.0.0.0 由 docker -P 默认 —— 容器为一次性隔离实例)
    const portLine = execFileSync("docker", ["port", container, "5432"], { encoding: "utf8", timeout: 15_000 });
    mainPort = portLine.split("\n")[0]!.split(":").pop()!.trim();
    mainUrl = `postgresql://postgres:${dbPassword}@127.0.0.1:${mainPort}/relayd08`;
    // 就绪等待(pg_isready;30s 上限)
    for (let i = 0; i < 30; i++) {
      try {
        dexec(["pg_isready", "-U", "postgres", "-d", "relayd08"]);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    admin = new pg.Pool({ connectionString: mainUrl, max: 4 });
    await admin.query("SELECT 1");
    restoreUrl = `postgresql://postgres:${dbPassword}@127.0.0.1:${mainPort}/${restoreDb}`;
  }, TIMEOUT);

  afterAll(async () => {
    if (admin) await admin.end().catch(() => {});
    try {
      execFileSync("docker", ["rm", "-f", container], { timeout: 60_000 });
    } catch {
      /* 容器可能已退出 */
    }
    if (tmpRoot) safeRm(tmpRoot, { roots: [tmpRoot], sentinel: RUN_SENTINEL });
  }, TIMEOUT);

  it("备份(0007 形状)→ 真实增量迁移 0008/0009 → 恢复回退到 0007(数据/约束/触发器保真)", {
    timeout: TIMEOUT,
  }, async () => {
    const pool = admin!;

    // ── 1) 0007 旧形状 + 合成行 ──
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    const c = await pool.connect();
    try {
      await applyMigrationRange(c, schemaName, 7);
    } finally {
      c.release();
    }
    const w = await pool.connect();
    try {
      await w.query(`SET search_path TO "${schemaName}"`);
      await w.query(
        `INSERT INTO goals (id, raw_input, budget) VALUES ('goal-e2e-1', '演练合成目标:中文+jsonb保真@08', '{"modelCalls":4,"note":"中文"}'::jsonb)`,
      );
      await w.query(
        `INSERT INTO tasks (id, state, priority, allowed_scope, gate_required, max_attempts) VALUES ('task-e2e-1', 'SUCCEEDED', 2, '[]'::jsonb, true, 3)`,
      );
      await w.query(
        `INSERT INTO runs (id, task_id, attempt, model_ref, budget, sandbox, outcome, detail) VALUES ('run-e2e-1', 'task-e2e-1', 1, 'rehearsal/synthetic', '{"reserveCallsPerRun":2}', 'docker', 'SUCCEEDED', '{"role":"coder"}'::jsonb)`,
      );
      await w.query(
        `INSERT INTO goal_messages (goal_id, actor, kind, content) VALUES ('goal-e2e-1', 'USER', 'USER_MESSAGE', '迁移前合成消息一(中文)'), ('goal-e2e-1', 'RELAY', 'RELAY_MESSAGE', '迁移前合成消息二')`,
      );
      await w.query(
        `INSERT INTO audit_events (actor, action, task_id, detail) VALUES ('rehearsal', 'D08_BACKUP_BASELINE', 'task-e2e-1', '{"synthetic":true}'::jsonb)`,
      );
      const sha = (ch: string): string => ch.repeat(64);
      await w.query(`INSERT INTO candidate_changesets (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope, delivery_state, git_commit_sha, delivered_remote_head)
        VALUES ('cs-e2e-1', 'task-e2e-1', 'run-e2e-1', 1, '${sha("b")}', '${sha("c")}', '${sha("d")}', '["src/a.ts"]'::jsonb, '["src"]'::jsonb, 'DELIVERED', '${sha("e")}', 'remote-head-e2e')`);
    } finally {
      w.release();
    }

    // ── 2) 备份(backup.sh 步骤1 同命令形态) + manifest(真实脚本) + 审计索引(schema 限定) + 校验和 ──
    const backupDir = join(tmpRoot, "backup");
    mkdirSync(backupDir, { recursive: true });
    const dumpFile = join(backupDir, "db-e2e.sql");
    writeFileSync(dumpFile, dexec(["pg_dump", "-U", "postgres", "--no-owner", "--no-privileges", "relayd08"]));
    expect(readFileSync(dumpFile, "utf8")).toContain(`CREATE SCHEMA ${schemaName}`);
    // 跨 schema 交付 manifest(真实 deploy/backup-manifest.mjs;RELAY_DB_URL 指向一次性实例)
    execFileSync("node", ["deploy/backup-manifest.mjs", backupDir, join(backupDir, "artifacts-manifest-e2e.json")], {
      cwd: join(import.meta.dirname, "../.."),
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, RELAY_DB_URL: mainUrl },
    });
    const manifest = JSON.parse(readFileSync(join(backupDir, "artifacts-manifest-e2e.json"), "utf8"));
    expect(manifest.delivered.length).toBe(1);
    expect(manifest.delivered[0]).toMatchObject({ schema: schemaName, changesetId: "cs-e2e-1" });
    // 审计索引(backup.sh 步骤3 的 schema 限定等价形态;F-1 登记见 REPORT)
    const auditIndex = dexec([
      "psql",
      "-U",
      "postgres",
      "-d",
      "relayd08",
      "-tA",
      "-c",
      `SELECT seq || '|' || actor || '|' || action FROM "${schemaName}".audit_events ORDER BY seq`,
    ]);
    expect(auditIndex).toContain("D08_BACKUP_BASELINE");
    // 校验和(backup.sh 步骤4 形态;路径取相对名便于 -c 校验)
    const sum = execFileSync("sha256sum", [dumpFile, join(backupDir, "artifacts-manifest-e2e.json")], {
      encoding: "utf8",
    });
    writeFileSync(
      join(backupDir, "checksums-e2e.sha256"),
      sum
        .split("\n")
        .map((l) => l.replace(/ \/[^ ]*/, " " + l.split(" ").pop()))
        .join("\n") + "\n",
    );

    // ── 3) 真实增量迁移 0007→0009(演练工具;守卫通过:p01a_/回环/显式端口) ──
    const report = await applyIncrementalMigration(pool, schemaName, { url: mainUrl });
    expect(report.steps.map((s) => `${s.tag}:${s.status}`)).toEqual([
      "0008_goal_messages_execution_request:applied",
      "0009_tasks_abort_requested:applied",
    ]);
    expect(report.verification.ok).toBe(true);
    const post = await verifyPostMigrationState(pool, schemaName);
    expect(post.ok).toBe(true);
    // 代码回退兼容实证:旧代码形态 INSERT(不引用新列)在迁移后 schema 上成功且默认回填 false
    await pool.query(
      `INSERT INTO "${schemaName}".goal_messages (goal_id, actor, kind, content) VALUES ('goal-e2e-1', 'USER', 'USER_MESSAGE', '迁移后旧行为写入(代码回退兼容)')`,
    );
    const msgs = await pool.query(`SELECT content, execution_request FROM "${schemaName}".goal_messages ORDER BY id`);
    expect(msgs.rows.length).toBe(3);
    expect(msgs.rows.every((r) => r["execution_request"] === false)).toBe(true);

    // ── 4) 恢复(restore-verify.sh 容器路径同形态:新库 + ON_ERROR_STOP 导入)+ 真实脚本交叉核对 ──
    dexec(["psql", "-U", "postgres", "-c", `DROP DATABASE IF EXISTS ${restoreDb}`]);
    dexec(["psql", "-U", "postgres", "-c", `CREATE DATABASE ${restoreDb}`]);
    dexec(["psql", "-U", "postgres", "-d", restoreDb, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"], {
      input: readFileSync(dumpFile, "utf8"),
      stdin: true,
    });
    // 真实 deploy/restore-verify-check.mjs(manifest ↔ 恢复库交叉核对)
    const checkOut = execFileSync(
      "node",
      [
        "deploy/restore-verify-check.mjs",
        join(backupDir, "artifacts-manifest-e2e.json"),
        join(backupDir, "artifacts-manifest-e2e.json"),
      ],
      {
        cwd: join(import.meta.dirname, "../.."),
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, RESTORE_TARGET_URL: restoreUrl },
      },
    );
    expect(checkOut).toContain("一致 ✓");

    // ── 5) 回退边界断言:恢复库 = 0007 形状 + 数据/约束/触发器保真 ──
    const rdb = new pg.Pool({ connectionString: restoreUrl, max: 2 });
    try {
      const mk = await rdb.query(
        `SELECT
           (SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='goal_messages' AND column_name='execution_request') g8,
           (SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='abort_requested_at') g9`,
        [schemaName],
      );
      expect(Number(mk.rows[0]!["g8"])).toBe(0); // 恢复=备份时点形状(迁移前)
      expect(Number(mk.rows[0]!["g9"])).toBe(0);
      const rows = await rdb.query(`SELECT content FROM "${schemaName}".goal_messages ORDER BY id`);
      expect(rows.rows.map((r) => r["content"])).toEqual(["迁移前合成消息一(中文)", "迁移前合成消息二"]); // 迁移阶段写入不在备份内
      const trig = await rdb.query(
        `SELECT count(*)::int AS n FROM information_schema.triggers WHERE trigger_schema=$1 AND event_object_table='goal_messages'`,
        [schemaName],
      );
      expect(Number(trig.rows[0]!["n"])).toBeGreaterThanOrEqual(1); // append-only 守卫随 schema 恢复
      const fks = await rdb.query(
        `SELECT count(*)::int AS n FROM information_schema.table_constraints WHERE table_schema=$1 AND table_name='goal_message_consumptions' AND constraint_type='FOREIGN KEY'`,
        [schemaName],
      );
      expect(Number(fks.rows[0]!["n"])).toBe(3);
      const del = await rdb.query(
        `SELECT count(*)::int AS n FROM "${schemaName}".candidate_changesets WHERE delivery_state='DELIVERED'`,
      );
      expect(Number(del.rows[0]!["n"])).toBe(1);
    } finally {
      await rdb.end().catch(() => {});
    }
  });
});
