// RELAY-BACKUP-INTEGRITY-09 D 项:修后真实 backup.sh / restore-verify.sh / manifest / check 全链验收
// (双租户一次性 PG;08R 回环安全门复用;零生产触碰,全部合成数据)。
// 拓扑:源实例(租户 A=备份目标 / B=其他租户 / C=零审计零交付边界 + public.audit_events 干扰表,
//       模拟 VM80 relayp000 已实证的 DBOS 遗留)⇒ 修后 backup.sh 仅导出目标 A;
//       隔离恢复实例(独立一次性容器)⇒ 真实 restore-verify.sh(RELAY_RESTORE_ISOLATED 守卫)+ 身份核对。
// 反例红态(对 a458e95 原始脚本):p0-mvp/backup-integrity-09/evidence/red09-*.log(整库混入/错源/
//       相同计数假阳性/无隔离守卫/宿主分支未限定 argv)。本套件钉死修复后语义:
//   1) schema 模式主链:A 内容保真、B/C/public 零混入、审计/DELIVERED 精确归属、校验和与完成标记、
//      隔离恢复 + 集合身份核对、触发器/FK/append-only 恢复后可用;
//   2) 扰动 B 不改变 A 的备份产物(manifest/审计索引逐字节相等);
//   3) fail-closed 矩阵:未声明 schema/目标不存在/错容器/未声明隔离/恢复目标=源实例/缺完成标记/
//      审计索引篡改/身份扰动/legacy manifest 一律拒绝且清理自身产物;
//   4) 宿主分支覆盖:VM80 宿主无 pg_dump/psql ⇒ 以可验证命令注入(PATH shim,argv 捕获)证明宿主分支
//      命令形态已 schema 限定(-n + 限定审计索引);docker fallback 的完整真跑在 VM80 主链承担;
//   5) all 模式 = 显式旧版整库/跨 schema 兼容语义(含 public 遗留,如实聚合),可重复演示。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { dockerAvailable } from "../../src/runtime/sandbox.ts";
import { markTemp, safeRm, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";
import { applyMigrationRange } from "../../deploy/rehearse-migration.ts";
import { startEphemeralPg, destroyEphemeralPg } from "./d08-ephemeral-pg.ts";

const dockerOk = dockerAvailable();
console.log(`[d09 门控] docker=${dockerOk}`);
const TIMEOUT = 600_000;
const REPO = join(import.meta.dirname, "../..");

describe.skipIf(!dockerOk)("RELAY-BACKUP-INTEGRITY-09:修后真实备份/恢复全链(合成双租户一次性 PG)", () => {
  const uid = randomUUID().slice(0, 8);
  const srcContainer = `relay-test-d09-src-${uid}`;
  const rstContainer = `relay-test-d09-rst-${uid}`;
  const schA = `p01a_d09a_${uid}`;
  const schB = `p01a_d09b_${uid}`;
  const schC = `p01a_d09c_${uid}`;
  let tmpRoot = "";
  let srcPort = "";
  let srcUrl = ""; // postgresql://...@127.0.0.1:port/relayd08(源实例)
  let srcBase = ""; // 源实例 base(不带库名;用于恢复误指守卫反例)
  let rstBase = ""; // 隔离恢复实例 base
  let backupDir1 = "";
  let backupDir2 = "";
  let manifest1 = "";

  const dexec = (
    container: string,
    args: string[],
    opts: { input?: string; maxBuffer?: number; stdin?: boolean } = {},
  ): string =>
    execFileSync("docker", ["exec", ...(opts.stdin ? ["-i"] : []), container, ...args], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });

  const runScript = (
    script: string,
    args: string[],
    env: Record<string, string | undefined>,
  ): { status: number; out: string } => {
    try {
      const out = execFileSync("bash", [script, ...args], {
        cwd: REPO,
        encoding: "utf8",
        timeout: 240_000,
        maxBuffer: 64 * 1024 * 1024,
        env,
      });
      return { status: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  /** 基础 env:清除可能残留的 RELAY_DB_URL(守卫/主链各自显式注入)。 */
  const baseEnv = (): Record<string, string | undefined> => {
    const e: Record<string, string | undefined> = { ...process.env };
    delete e.RELAY_DB_URL;
    delete e.RELAY_BACKUP_SCHEMA;
    delete e.RELAY_RESTORE_ISOLATED;
    return e;
  };

  const restoreDbNames = (container: string): string[] =>
    dexec(container, [
      "psql",
      "-U",
      "postgres",
      "-tA",
      "-c",
      "SELECT datname FROM pg_database WHERE datname LIKE 'relay_restore_v%'",
    ])
      .split("\n")
      .filter((l) => l.trim().length > 0);

  const stampFiles = (dir: string): string[] => {
    try {
      return execFileSync("ls", [dir], { encoding: "utf8" }).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };

  beforeAll(async () => {
    tmpRoot = markTemp(mkdtempSync(join(tmpdir(), "d09-backup-")));
    const password = `d09-${uid}`;
    const src = startEphemeralPg({ container: srcContainer, password });
    const rst = startEphemeralPg({ container: rstContainer, password });
    srcPort = src.hostPort;
    srcUrl = `postgresql://postgres:${password}@127.0.0.1:${srcPort}/relayd08`;
    srcBase = `postgresql://postgres:${password}@127.0.0.1:${srcPort}`;
    rstBase = `postgresql://postgres:${password}@127.0.0.1:${rst.hostPort}`;
    // 就绪门(与 08 E2E 同口径:真实 SELECT 1 重试 90s;initdb 窗口连接可能被接受后立即终止)
    const readyPool = new pg.Pool({ connectionString: srcUrl, max: 2 });
    let ready = false;
    let lastErr = "";
    for (let i = 0; i < 90; i++) {
      try {
        await readyPool.query("SELECT 1");
        ready = true;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    await readyPool.end().catch(() => {});
    if (!ready) throw new Error(`一次性 PG 容器未就绪(90s SELECT 1 重试;最后错误:${lastErr})`);
    let rstReady = false;
    for (let i = 0; i < 90 && !rstReady; i++) {
      try {
        dexec(rstContainer, ["psql", "-U", "postgres", "-d", "relayd08", "-tA", "-c", "SELECT 1"]);
        rstReady = true;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!rstReady) throw new Error("隔离恢复容器未就绪(90s)");

    // 合成双租户:0007 形状 ×3(A=目标 / B=他租户 / C=零审计零交付边界)
    const admin = new pg.Pool({ connectionString: srcUrl, max: 4 });
    try {
      for (const sch of [schA, schB, schC]) {
        await admin.query(`CREATE SCHEMA "${sch}"`);
        const c = await admin.connect();
        try {
          await applyMigrationRange(c, sch, 7);
        } finally {
          c.release();
        }
      }
      const w = await admin.connect();
      try {
        await w.query(`SET search_path TO "${schA}"`);
        await w.query(
          `INSERT INTO goals (id, raw_input, budget) VALUES ('goal-d09-a1', '目标A:租户甲合成数据@09', '{"modelCalls":2,"note":"中文A"}'::jsonb)`,
        );
        await w.query(
          `INSERT INTO tasks (id, state, priority, allowed_scope, gate_required, max_attempts) VALUES ('task-d09-a1', 'SUCCEEDED', 2, '[]'::jsonb, true, 3)`,
        );
        await w.query(
          `INSERT INTO runs (id, task_id, attempt, model_ref, budget, sandbox, outcome, detail) VALUES ('run-d09-a1', 'task-d09-a1', 1, 'd09/synthetic', '{"reserveCallsPerRun":1}', 'docker', 'SUCCEEDED', '{"tenant":"A"}'::jsonb)`,
        );
        await w.query(`INSERT INTO audit_events (actor, action, task_id, detail) VALUES
          ('tenant-a', 'A_AUDIT_1', 'task-d09-a1', '{"n":1}'::jsonb),
          ('tenant-a', 'A_AUDIT_2', 'task-d09-a1', '{"n":2}'::jsonb),
          ('tenant-a', 'A_AUDIT_3', 'task-d09-a1', '{"n":3}'::jsonb)`);
        const sha = (s: string): string => s.repeat(64);
        await w.query(`INSERT INTO candidate_changesets (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope, delivery_state, git_commit_sha, delivered_remote_head)
          VALUES ('cs-d09-a1', 'task-d09-a1', 'run-d09-a1', 1, '${sha("b1")}', '${sha("c1")}', '${sha("d1")}', '["src/a1.ts"]'::jsonb, '["src"]'::jsonb, 'DELIVERED', '${sha("e1")}', 'remote-head-A1'),
                 ('cs-d09-a2', 'task-d09-a1', 'run-d09-a1', 2, '${sha("b2")}', '${sha("c2")}', '${sha("d2")}', '["src/a2.ts"]'::jsonb, '["src"]'::jsonb, 'PENDING', '${sha("e2")}', NULL)`);
        await w.query(`SET search_path TO "${schB}"`);
        await w.query(
          `INSERT INTO goals (id, raw_input, budget) VALUES ('goal-d09-b1', '目标B:租户乙合成数据@09-不得混入', '{"modelCalls":9}'::jsonb)`,
        );
        await w.query(
          `INSERT INTO tasks (id, state, priority, allowed_scope, gate_required, max_attempts) VALUES ('task-d09-b1', 'SUCCEEDED', 5, '[]'::jsonb, true, 1)`,
        );
        await w.query(
          `INSERT INTO runs (id, task_id, attempt, model_ref, budget, sandbox, outcome, detail) VALUES ('run-d09-b1', 'task-d09-b1', 1, 'd09/synthetic-b', '{"reserveCallsPerRun":9}', 'docker', 'FAILED', '{"tenant":"B"}'::jsonb)`,
        );
        await w.query(`INSERT INTO audit_events (actor, action, task_id, detail) VALUES
          ('tenant-b', 'B_AUDIT_1', 'task-d09-b1', '{"n":100}'::jsonb),
          ('tenant-b', 'B_AUDIT_2', 'task-d09-b1', '{"n":200}'::jsonb)`);
        await w.query(`INSERT INTO candidate_changesets (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope, delivery_state, git_commit_sha, delivered_remote_head)
          VALUES ('cs-d09-b1', 'task-d09-b1', 'run-d09-b1', 1, '${sha("f1")}', '${sha("g1")}', '${sha("h1")}', '["src/b1.ts"]'::jsonb, '["src"]'::jsonb, 'DELIVERED', '${sha("i1")}', 'remote-head-B1'),
                 ('cs-d09-b2', 'task-d09-b1', 'run-d09-b1', 2, '${sha("f2")}', '${sha("g2")}', '${sha("h2")}', '["src/b2.ts"]'::jsonb, '["src"]'::jsonb, 'DELIVERED', '${sha("i2")}', 'remote-head-B2')`);
      } finally {
        w.release();
      }
      // C = 迁移但零行(零审计零交付边界);public.audit_events 干扰表(合成模拟 relayp000 遗留)
      await admin.query(`CREATE TABLE IF NOT EXISTS public.audit_events (
        seq bigserial PRIMARY KEY, ts timestamptz DEFAULT now() NOT NULL, actor text NOT NULL, action text NOT NULL)`);
      await admin.query(`INSERT INTO public.audit_events (actor, action) VALUES
        ('dbos-leftover', 'DECOY_PUBLIC_LEFTOVER_1'), ('dbos-leftover', 'DECOY_PUBLIC_LEFTOVER_2')`);
    } finally {
      await admin.end().catch(() => {});
    }

    backupDir1 = join(tmpRoot, "backup-a1");
    backupDir2 = join(tmpRoot, "backup-a2");
    manifest1 = join(backupDir1, "manifest.json");
  }, TIMEOUT);

  afterAll(async () => {
    destroyEphemeralPg(srcContainer, (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }));
    destroyEphemeralPg(rstContainer, (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }));
    if (tmpRoot) safeRm(tmpRoot, { roots: [tmpRoot], sentinel: RUN_SENTINEL });
  }, TIMEOUT);

  it("主链:schema 模式真实 backup.sh(A 专属)→ 真实 restore-verify.sh(隔离实例)→ 身份核对 + 恢复后可用", {
    timeout: TIMEOUT,
  }, async () => {
    // ── 1) 修后真实 backup.sh(docker fallback 真跑;宿主分支形态由宿主 shim 用例承担)──
    const r1 = runScript("deploy/backup.sh", [backupDir1], {
      ...baseEnv(),
      RELAY_DB_URL: srcUrl,
      RELAY_BACKUP_SCHEMA: schA,
      RELAY_PG_CONTAINER: srcContainer,
    });
    expect(r1.status, `backup.sh 应成功:${r1.out.slice(0, 500)}`).toBe(0);
    expect(r1.out).toContain(`schema=${schA}`);
    const stamp1 = r1.out.match(/(\d{8}T\d{6}Z)/)?.[1] ?? "";
    expect(stamp1).not.toBe("");

    // 完成标记 + 校验和 + 产物唯一性
    const marker = readFileSync(join(backupDir1, `backup-${stamp1}.done`), "utf8");
    expect(marker).toContain("backup-complete");
    expect(marker).toContain(`schema=${schA}`);
    const files1 = stampFiles(backupDir1);
    expect(files1.filter((f) => f.startsWith("db-")).length).toBe(1);
    expect(files1.filter((f) => f.startsWith("artifacts-manifest-")).length).toBe(1);
    execFileSync("sha256sum", ["-c", `checksums-${stamp1}.sha256`], {
      cwd: backupDir1,
      stdio: "ignore",
      timeout: 30_000,
    });

    // dump 作用域:含 A 全部 15 张表;零 B/C/public 混入(pg_dump 输出为不带引号的限定名)
    const dump1 = readFileSync(join(backupDir1, `db-${stamp1}.sql`), "utf8");
    // 0007 形状 = 16 表(13 基座 + goal_messages + goal_message_consumptions + discoveries)
    expect(dump1.match(new RegExp(`CREATE TABLE ${schA}\\.`, "g"))?.length).toBe(16);
    expect(dump1).toContain(`CREATE SCHEMA ${schA}`);
    expect(dump1).not.toContain(`CREATE SCHEMA ${schB}`);
    expect(dump1).not.toContain(`CREATE SCHEMA ${schC}`);
    expect(dump1).not.toContain("CREATE TABLE public.audit_events");
    expect(dump1).not.toContain("B_AUDIT_1");
    expect(dump1).not.toContain("DECOY_PUBLIC_LEFTOVER");
    expect(dump1).toContain("A_AUDIT_1");
    expect(dump1).toContain("目标A:租户甲合成数据@09");
    // dump 对象覆盖:触发器与 FK 随 schema 导出
    expect(dump1).toMatch(/CREATE TRIGGER/);
    expect(dump1).toMatch(/FOREIGN KEY/);

    // manifest:只认目标 A;PENDING/他租户不入
    const manifest = JSON.parse(readFileSync(join(backupDir1, `artifacts-manifest-${stamp1}.json`), "utf8"));
    expect(manifest.targetSchema).toBe(schA);
    expect(manifest.delivered.length).toBe(1);
    expect(manifest.delivered[0]).toMatchObject({
      schema: schA,
      changesetId: "cs-d09-a1",
      remoteHead: "remote-head-A1",
    });
    copyFileSync(join(backupDir1, `artifacts-manifest-${stamp1}.json`), manifest1);

    // 审计索引:schema 限定(3 行全 A;零 decoy/零 B;seq|ts|actor|action 规范行)
    const auditLines = readFileSync(join(backupDir1, `audit-index-${stamp1}.txt`), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(auditLines.length).toBe(3);
    expect(auditLines.every((l) => l.includes("tenant-a|A_AUDIT_"))).toBe(true);

    // ── 2) 修后真实 restore-verify.sh(隔离恢复实例;守卫全过)──
    expect(restoreDbNames(rstContainer).length).toBe(0);
    const r2 = runScript("deploy/restore-verify.sh", [backupDir1, rstBase], {
      ...baseEnv(),
      RELAY_RESTORE_ISOLATED: "1",
      RELAY_RESTORE_CONTAINER: rstContainer,
    });
    expect(r2.status, `restore-verify.sh 应成功:${r2.out.slice(0, 800)}`).toBe(0);
    const rstDb = r2.out.match(/目标库:(relay_restore_v\S+)/)?.[1] ?? "";
    expect(rstDb).not.toBe("");
    expect(r2.out).toContain("集合身份一致 ✓");
    expect(r2.out).toContain("审计索引:备份=3 行 恢复后=3 行");
    expect(r2.out).toContain("核对通过");

    // ── 3) 恢复库逐项核对:目标身份 + 内容保真 + 触发器/FK/append-only 可用 ──
    const rq = (sql: string): string =>
      dexec(rstContainer, ["psql", "-U", "postgres", "-d", rstDb, "-tA", "-c", sql]).trim();
    expect(rq(`SELECT count(*) FROM information_schema.tables WHERE table_schema='${schA}'`)).toBe("16");
    expect(rq(`SELECT count(*) FROM information_schema.tables WHERE table_schema='${schB}'`)).toBe("0");
    expect(rq(`SELECT raw_input FROM "${schA}".goals WHERE id='goal-d09-a1'`)).toContain("目标A:租户甲合成数据");
    expect(rq(`SELECT budget->>'note' FROM "${schA}".goals WHERE id='goal-d09-a1'`)).toBe("中文A");
    expect(rq(`SELECT count(*) FROM "${schA}".audit_events`)).toBe("3");
    expect(rq(`SELECT count(*) FROM "${schA}".candidate_changesets WHERE delivery_state='DELIVERED'`)).toBe("1");
    expect(
      Number(
        rq(
          `SELECT count(*) FROM information_schema.triggers WHERE trigger_schema='${schA}' AND event_object_table='audit_events'`,
        ),
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      rq(
        `SELECT count(*) FROM information_schema.table_constraints WHERE table_schema='${schA}' AND table_name='goal_message_consumptions' AND constraint_type='FOREIGN KEY'`,
      ),
    ).toBe("3");
    // append-only 守卫恢复后仍生效:删除审计行必须被触发器拒绝
    let appendOnlyRejected = false;
    try {
      dexec(rstContainer, [
        "psql",
        "-U",
        "postgres",
        "-d",
        rstDb,
        "-c",
        `DELETE FROM "${schA}".audit_events WHERE seq=1`,
      ]);
    } catch {
      appendOnlyRejected = true;
    }
    expect(appendOnlyRejected, "恢复库审计 append-only 触发器应拒绝 DELETE").toBe(true);
  });

  it("扰动 B 不改变 A 的备份产物(manifest/审计索引逐字节相等;B 新行零进入)", { timeout: TIMEOUT }, async () => {
    const admin = new pg.Pool({ connectionString: srcUrl, max: 2 });
    try {
      await admin.query(`INSERT INTO "${schB}".audit_events (actor, action) VALUES ('tenant-b', 'B_AUDIT_3')`);
      const sha = (s: string): string => s.repeat(64);
      await admin.query(`INSERT INTO "${schB}".candidate_changesets (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope, delivery_state, git_commit_sha, delivered_remote_head)
        VALUES ('cs-d09-b4', 'task-d09-b1', 'run-d09-b1', 4, '${sha("f4")}', '${sha("g4")}', '${sha("h4")}', '["src/b4.ts"]'::jsonb, '["src"]'::jsonb, 'DELIVERED', '${sha("i4")}', 'remote-head-B4')`);
    } finally {
      await admin.end().catch(() => {});
    }
    const r = runScript("deploy/backup.sh", [backupDir2], {
      ...baseEnv(),
      RELAY_DB_URL: srcUrl,
      RELAY_BACKUP_SCHEMA: schA,
      RELAY_PG_CONTAINER: srcContainer,
    });
    expect(r.status).toBe(0);
    const stamp2 = r.out.match(/(\d{8}T\d{6}Z)/)?.[1] ?? "";
    const manifest2 = JSON.parse(readFileSync(join(backupDir2, `artifacts-manifest-${stamp2}.json`), "utf8"));
    const manifest1Data = JSON.parse(readFileSync(manifest1, "utf8"));
    expect(manifest2.targetSchema).toBe(schA);
    expect(JSON.stringify(manifest2.delivered)).toBe(JSON.stringify(manifest1Data.delivered));
    expect(manifest2.delivered.some((d: { changesetId: string }) => d.changesetId === "cs-d09-b4")).toBe(false);
    const audit2 = readFileSync(join(backupDir2, `audit-index-${stamp2}.txt`), "utf8");
    const stamp1 = stampFiles(backupDir1).find((f) => f.startsWith("audit-index-"))!;
    expect(audit2).toBe(readFileSync(join(backupDir1, stamp1), "utf8"));
    const dump2 = readFileSync(join(backupDir2, `db-${stamp2}.sql`), "utf8");
    expect(dump2).not.toContain("B_AUDIT");
    expect(dump2).not.toContain("cs-d09-b4");
    expect(dump2).toContain("A_AUDIT_1");
  });

  it("fail-closed 矩阵:未声明 schema/目标不存在/错容器/未声明隔离/恢复=源实例/缺标记/篡改/身份扰动/legacy manifest 一律拒绝", {
    timeout: TIMEOUT,
  }, async () => {
    // a) backup.sh 未声明 RELAY_BACKUP_SCHEMA ⇒ 拒绝且零产物(校验先于 mkdir)
    const outA = join(tmpRoot, "refuse-noschema");
    const ra = runScript("deploy/backup.sh", [outA], {
      ...baseEnv(),
      RELAY_DB_URL: srcUrl,
      RELAY_PG_CONTAINER: srcContainer,
    });
    expect(ra.status).not.toBe(0);
    expect(ra.out).toContain("RELAY_BACKUP_SCHEMA");
    expect(stampFiles(outA).length).toBe(0);

    // b) 目标 schema 不存在 ⇒ fail-closed(validate 真连校验)且零产物
    const outB = join(tmpRoot, "refuse-badschema");
    const rb = runScript("deploy/backup.sh", [outB], {
      ...baseEnv(),
      RELAY_DB_URL: srcUrl,
      RELAY_BACKUP_SCHEMA: "p01a_nonexistent_xyz",
      RELAY_PG_CONTAINER: srcContainer,
    });
    expect(rb.status).not.toBe(0);
    expect(rb.out).toContain("p01a_nonexistent_xyz");
    expect(stampFiles(outB).length).toBe(0);

    // c) 错容器 ⇒ dump 失败 ⇒ 拒绝且清理本 STAMP 产物
    const outC = join(tmpRoot, "refuse-wrongcontainer");
    const rc2 = runScript("deploy/backup.sh", [outC], {
      ...baseEnv(),
      RELAY_DB_URL: srcUrl,
      RELAY_BACKUP_SCHEMA: schA,
      RELAY_PG_CONTAINER: "relay-d09-nonexistent-xyz",
    });
    expect(rc2.status).not.toBe(0);
    expect(stampFiles(outC).filter((f) => f.startsWith("db-")).length).toBe(0);
    expect(stampFiles(outC).filter((f) => f.endsWith(".done")).length).toBe(0);

    // d) restore-verify.sh 未声明 RELAY_RESTORE_ISOLATED ⇒ 拒绝且零 DROP/CREATE
    const beforeD = restoreDbNames(rstContainer).length;
    const rd = runScript("deploy/restore-verify.sh", [backupDir1, rstBase], {
      ...baseEnv(),
      RELAY_RESTORE_CONTAINER: rstContainer,
    });
    expect(rd.status).not.toBe(0);
    expect(rd.out).toContain("RELAY_RESTORE_ISOLATED");
    expect(restoreDbNames(rstContainer).length).toBe(beforeD);

    // e) 恢复目标=备份源实例 ⇒ 实例前缀守卫拒绝,源实例零新库
    const srcBefore = restoreDbNames(srcContainer).length;
    const re = runScript("deploy/restore-verify.sh", [backupDir1, srcBase], {
      ...baseEnv(),
      RELAY_DB_URL: srcUrl,
      RELAY_RESTORE_ISOLATED: "1",
      RELAY_RESTORE_CONTAINER: rstContainer,
    });
    expect(re.status).not.toBe(0);
    expect(re.out).toContain("恢复目标实例与备份源实例相同");
    expect(restoreDbNames(srcContainer).length).toBe(srcBefore);

    // f) 备份目录缺完成标记(失败残留形态)⇒ 拒绝
    const partial = join(tmpRoot, "partial-backup");
    mkdirSync(partial, { recursive: true });
    const stamp1 = stampFiles(backupDir1).find((f) => f.startsWith("db-"))!;
    copyFileSync(join(backupDir1, stamp1), join(partial, stamp1));
    const rf = runScript("deploy/restore-verify.sh", [partial, rstBase], {
      ...baseEnv(),
      RELAY_RESTORE_ISOLATED: "1",
      RELAY_RESTORE_CONTAINER: rstContainer,
    });
    expect(rf.status).not.toBe(0);
    expect(rf.out).toContain("完成标记");

    // f2) 恢复中途失败(psql -f 在建库后异常)⇒ trap 清理部分恢复库(Reviewer Round1 Major-1 消化)
    const midDir = join(tmpRoot, "backup-midfail");
    mkdirSync(midDir, { recursive: true });
    const midStamp = "20260101T000000Z";
    const dump1Text = readFileSync(join(backupDir1, stamp1), "utf8");
    writeFileSync(
      join(midDir, `db-${midStamp}.sql`),
      `${dump1Text}\n-- d09 注入:恢复中途失败注入点(ON_ERROR_STOP 中途失败)\nTHIS IS NOT VALID SQL;\n`,
    );
    copyFileSync(manifest1, join(midDir, `artifacts-manifest-${midStamp}.json`));
    copyFileSync(
      join(backupDir1, stampFiles(backupDir1).find((f) => f.startsWith("audit-index-"))!),
      join(midDir, `audit-index-${midStamp}.txt`),
    );
    writeFileSync(join(midDir, `backup-${midStamp}.done`), `backup-complete\nstamp=${midStamp}\nschema=${schA}\n`);
    const midSum = execFileSync(
      "sha256sum",
      [
        `db-${midStamp}.sql`,
        `artifacts-manifest-${midStamp}.json`,
        `audit-index-${midStamp}.txt`,
        `backup-${midStamp}.done`,
      ],
      { cwd: midDir, encoding: "utf8" },
    );
    writeFileSync(join(midDir, `checksums-${midStamp}.sha256`), midSum);
    const beforeMid = restoreDbNames(rstContainer).length;
    const rMid = runScript("deploy/restore-verify.sh", [midDir, rstBase], {
      ...baseEnv(),
      RELAY_RESTORE_ISOLATED: "1",
      RELAY_RESTORE_CONTAINER: rstContainer,
    });
    expect(rMid.status).not.toBe(0);
    expect(rMid.out).toContain("已清理本次恢复库");
    expect(restoreDbNames(rstContainer).length, "部分恢复库应被 trap 清理,零残留").toBe(beforeMid);

    // g) 身份扰动(目标 A 交付行被他租户形态行替代,总数相等)⇒ check.mjs 集合身份拒绝
    const tampDb = "relayd09tamp";
    dexec(rstContainer, ["psql", "-U", "postgres", "-c", `DROP DATABASE IF EXISTS ${tampDb}`, "-q"]);
    dexec(rstContainer, ["psql", "-U", "postgres", "-c", `CREATE DATABASE ${tampDb}`, "-q"]);
    // (-n dump 自带 CREATE SCHEMA,无需预建;红态已实证 "already exists" 冲突)
    const stamp1db = stampFiles(backupDir1).find((f) => f.startsWith("db-"))!;
    execFileSync(
      "docker",
      ["exec", "-i", rstContainer, "psql", "-U", "postgres", "-d", tampDb, "-v", "ON_ERROR_STOP=1", "-q"],
      {
        input: readFileSync(join(backupDir1, stamp1db)),
        timeout: 120_000,
      },
    );
    dexec(rstContainer, [
      "psql",
      "-U",
      "postgres",
      "-d",
      tampDb,
      "-q",
      "-c",
      `DELETE FROM "${schA}".candidate_changesets WHERE id='cs-d09-a1'`,
    ]);
    const sha = (s: string): string => s.repeat(64);
    dexec(rstContainer, [
      "psql",
      "-U",
      "postgres",
      "-d",
      tampDb,
      "-q",
      "-c",
      `INSERT INTO "${schA}".candidate_changesets (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope, delivery_state, git_commit_sha, delivered_remote_head)
       VALUES ('cs-d09-a1-sub', 'task-d09-a1', 'run-d09-a1', 9, '${sha("z")}', '${sha("z")}', '${sha("z")}', '["src/z.ts"]'::jsonb, '["src"]'::jsonb, 'DELIVERED', '${sha("z")}', 'remote-head-ZZZ')`,
    ]);
    let tampOut = "";
    let tampCode = 0;
    try {
      execFileSync(
        "node",
        [
          "deploy/restore-verify-check.mjs",
          manifest1,
          join(backupDir1, stampFiles(backupDir1).find((f) => f.startsWith("audit-index-"))!),
        ],
        {
          cwd: REPO,
          encoding: "utf8",
          timeout: 60_000,
          env: { ...baseEnv(), RESTORE_TARGET_URL: `${rstBase}/${tampDb}` },
        },
      );
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      tampCode = err.status ?? -1;
      tampOut = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    expect(tampCode).toBe(1);
    expect(tampOut).toContain("集合身份不一致");

    // h) 审计索引篡改(丢一行)⇒ 审计集合拒绝
    const faithDb = "relayd09faithful";
    dexec(rstContainer, ["psql", "-U", "postgres", "-c", `DROP DATABASE IF EXISTS ${faithDb}`, "-q"]);
    dexec(rstContainer, ["psql", "-U", "postgres", "-c", `CREATE DATABASE ${faithDb}`, "-q"]);
    execFileSync(
      "docker",
      ["exec", "-i", rstContainer, "psql", "-U", "postgres", "-d", faithDb, "-v", "ON_ERROR_STOP=1", "-q"],
      {
        input: readFileSync(join(backupDir1, stamp1db)),
        timeout: 120_000,
      },
    );
    const auditFile = join(backupDir1, stampFiles(backupDir1).find((f) => f.startsWith("audit-index-"))!);
    const auditLines = readFileSync(auditFile, "utf8").split("\n").filter(Boolean);
    writeFileSync(join(tmpRoot, "audit-index-tampered.txt"), auditLines.slice(1).join("\n") + "\n");
    let auditCode = 0;
    let auditOut = "";
    try {
      execFileSync("node", ["deploy/restore-verify-check.mjs", manifest1, join(tmpRoot, "audit-index-tampered.txt")], {
        cwd: REPO,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...baseEnv(), RESTORE_TARGET_URL: `${rstBase}/${faithDb}` },
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      auditCode = err.status ?? -1;
      auditOut = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    expect(auditCode).toBe(1);
    expect(auditOut).toContain("审计索引集合不一致");

    // i) legacy manifest(无 targetSchema)⇒ 拒绝核对
    const legacy = JSON.parse(readFileSync(manifest1, "utf8")) as Record<string, unknown>;
    delete legacy.targetSchema;
    const legacyPath = join(tmpRoot, "manifest-legacy.json");
    writeFileSync(legacyPath, JSON.stringify(legacy, null, 2));
    let legacyCode = 0;
    let legacyOut = "";
    try {
      execFileSync("node", ["deploy/restore-verify-check.mjs", legacyPath, auditFile], {
        cwd: REPO,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...baseEnv(), RESTORE_TARGET_URL: `${rstBase}/${faithDb}` },
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      legacyCode = err.status ?? -1;
      legacyOut = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    expect(legacyCode).not.toBe(0);
    expect(legacyOut).toContain("targetSchema");
  });

  it("宿主分支命令形态覆盖(PATH shim 可验证注入):pg_dump -n + 限定审计索引(与红态 Red-b 对照)", {
    timeout: TIMEOUT,
  }, async () => {
    const shimDir = join(tmpRoot, "shim-host");
    mkdirSync(shimDir, { recursive: true });
    const pgDumpShim = `#!/usr/bin/env bash
echo "pg_dump $*" >> "${tmpRoot}/captured-host-pgdump-argv.log"
prev=""; out=""
for a in "$@"; do [ "$prev" = "--file" ] && out="$a"; prev="$a"; done
[ -n "$out" ] && printf 'shim-dummy\\n' > "$out"
exit 0
`;
    const psqlShim = `#!/usr/bin/env bash
echo "psql $*" >> "${tmpRoot}/captured-host-psql-argv.log"
exit 0
`;
    writeFileSync(join(shimDir, "pg_dump"), pgDumpShim);
    writeFileSync(join(shimDir, "psql"), psqlShim);
    chmodSync(join(shimDir, "pg_dump"), 0o755);
    chmodSync(join(shimDir, "psql"), 0o755);

    const out = join(tmpRoot, "backup-host-branch");
    const r = runScript("deploy/backup.sh", [out], {
      ...baseEnv(),
      RELAY_DB_URL: srcUrl,
      RELAY_BACKUP_SCHEMA: schA,
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    });
    expect(r.status).toBe(0);
    const dumpArgv = readFileSync(join(tmpRoot, "captured-host-pgdump-argv.log"), "utf8");
    expect(dumpArgv).toContain(`-n ${schA}`);
    expect(dumpArgv).toContain("--file");
    const psqlArgv = readFileSync(join(tmpRoot, "captured-host-psql-argv.log"), "utf8");
    expect(psqlArgv).toContain(`FROM "${schA}".audit_events`);
    expect(psqlArgv).not.toMatch(/FROM audit_events/);
    // 宿主分支全链走完(完成标记落盘;manifest 为真实 node+pg 路径)
    expect(stampFiles(out).some((f) => f.endsWith(".done"))).toBe(true);
  });

  it("all 模式 = 显式旧版整库/跨 schema 兼容语义(可重复演示;如实含 public 遗留)", { timeout: TIMEOUT }, async () => {
    // 计数按当前实例实况动态取(前序用例会扰动 B;all 模式如实聚合全部)
    const deliveredTotal = Number(
      dexec(srcContainer, [
        "psql",
        "-U",
        "postgres",
        "-d",
        "relayd08",
        "-tA",
        "-c",
        `SELECT count(*) FROM (SELECT id FROM "${schA}".candidate_changesets WHERE delivery_state='DELIVERED' UNION ALL SELECT id FROM "${schB}".candidate_changesets WHERE delivery_state='DELIVERED' UNION ALL SELECT id FROM "${schC}".candidate_changesets WHERE delivery_state='DELIVERED') t`,
      ]).trim(),
    );
    const auditTotal = Number(
      dexec(srcContainer, [
        "psql",
        "-U",
        "postgres",
        "-d",
        "relayd08",
        "-tA",
        "-c",
        `SELECT count(*) FROM (SELECT seq FROM "${schA}".audit_events UNION ALL SELECT seq FROM "${schB}".audit_events UNION ALL SELECT seq FROM public.audit_events) t`,
      ]).trim(),
    );
    const outAll = join(tmpRoot, "backup-all");
    const r1 = runScript("deploy/backup.sh", [outAll], {
      ...baseEnv(),
      RELAY_DB_URL: srcUrl,
      RELAY_BACKUP_SCHEMA: "all",
      RELAY_PG_CONTAINER: srcContainer,
    });
    expect(r1.status).toBe(0);
    const stamp = r1.out.match(/(\d{8}T\d{6}Z)/)?.[1] ?? "";
    const dump = readFileSync(join(outAll, `db-${stamp}.sql`), "utf8");
    expect(dump).toContain(`CREATE SCHEMA ${schA}`);
    expect(dump).toContain(`CREATE SCHEMA ${schB}`);
    expect(dump).toContain("CREATE TABLE public.audit_events");
    const manifest = JSON.parse(readFileSync(join(outAll, `artifacts-manifest-${stamp}.json`), "utf8"));
    expect(manifest.targetSchema).toBe("all");
    expect(manifest.delivered.length).toBe(deliveredTotal);
    const auditLines = readFileSync(join(outAll, `audit-index-${stamp}.txt`), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(auditLines.length).toBe(auditTotal); // A + B + public 干扰(如实聚合)
    expect(auditLines.some((l) => l.includes("DECOY_PUBLIC_LEFTOVER"))).toBe(true);
    expect(readFileSync(join(outAll, `backup-${stamp}.done`), "utf8")).toContain("schema=all");

    // 旧版兼容语义端到端:整库恢复 + all 聚合身份核对 PASS
    const r2 = runScript("deploy/restore-verify.sh", [outAll, rstBase], {
      ...baseEnv(),
      RELAY_RESTORE_ISOLATED: "1",
      RELAY_RESTORE_CONTAINER: rstContainer,
    });
    expect(r2.status, `all 模式恢复应成功:${r2.out.slice(0, 800)}`).toBe(0);
    expect(r2.out).toContain("集合身份一致 ✓");
    expect(r2.out).toContain(`审计索引:备份=${auditTotal} 行 恢复后=${auditTotal} 行`);
    expect(r2.out).toContain("核对通过");
  });
});
