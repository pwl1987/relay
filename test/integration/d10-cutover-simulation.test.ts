// RELAY-CUTOVER-READINESS-10 C 项:技术切换前模拟全链(一次性双实例,零生产触碰)。
// 合同 C 逻辑序,全部真实工具 × 真实一次性 PG(08R 回环随机发布 helper),零 mock 冒充:
//   目标 schema 备份(09 schema 唯一入口)→ 隔离恢复校验(09R 身份门)→ 0007 形状(生产形态镜像:
//   生产 relay_console 现状=0000..0007 已应用、0008/0009 缺)→ 0008/0009 增量 plan+apply+重入+
//   半迁移续跑(08 rehearse-migration)→ 功能性 Gate 配置通过/失败(worker-entry resolveEvidenceChecks
//   真校验;docker 检查执行器真跑由既有 evidence-gate-rehearsal 3/3 承担,此处不重复)→
//   切换前后 preflight(真实 preflight 工具,经 defaultProbes({envPath,pgContainer}) 指向隔离实例,
//   与 CLI --env-file/--pg-container 同一探针路径)→ 回滚条件(备份恢复即回退目标形状;迁移后旧代码
//   形态写入成功且默认回填 false ⇒ 回退代码无需回滚 schema)。
// SIMULATED/NOT_RUN 边界(不得混谈):本套件证明的是「工具链与逻辑序在隔离实例上成立」;
// 生产切换本体(写 relay_console/重启服务/横幅核对/egress 自愈横幅)=NOT_RUN(硬边界禁止);
// preflight 其余检查项(svc/process_vs_head/egress/web_bind)反映宿主真实现状,不属本模拟断言。
// 生产 relay_console/public/真实数据零读写;一次性容器用后即毁;密码不出现在任何脚本输出(脱敏断言)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { dockerAvailable } from "../../src/runtime/sandbox.ts";
import { markTemp, safeRm, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";
import { startEphemeralPg, destroyEphemeralPg } from "./d08-ephemeral-pg.ts";
import {
  assertApplyTargetAuthorized,
  applyIncrementalMigration,
  applyMigrationRange,
  buildIncrementalPlan,
  detectMigrationShape,
  verifyPostMigrationState,
} from "../../deploy/rehearse-migration.ts";
import { defaultProbes, runPreflight } from "../../deploy/preflight.ts";
import { resolveEvidenceChecks } from "../../src/worker-entry.ts";

const TIMEOUT = 300_000;
const REPO = join(import.meta.dirname, "../..");
const uid = randomUUID().slice(0, 8);
const srcContainer = `relay-test-d10-src-${uid}`;
const rstContainer = `relay-test-d10-rst-${uid}`;
const TARGET = `p01a_d10_target`; // 0007 形状目标 schema(生产 relay_console 形态镜像)
const DECOY = `p01a_d10_other`; // 兄弟 schema 干扰物(schema 作用域证明)
const password = `d10-${uid}`;

describe.skipIf(!dockerAvailable())("RELAY-CUTOVER-READINESS-10:切换前模拟全链(一次性双实例)", () => {
  let tmpRoot = "";
  let srcUrl = "";
  let rstBase = "";
  let rstPort = "";
  let backupDir = "";
  let backupStamp = "";
  let restoreDb1 = "";
  let restoreDbUrl1 = "";

  const dexec = (container: string, args: string[]): string =>
    execFileSync("docker", ["exec", container, ...args], { encoding: "utf8", timeout: 120_000 });

  const runScript = (
    script: string,
    args: string[],
    env: Record<string, string | undefined>,
  ): { status: number; out: string } => {
    try {
      return {
        status: 0,
        out: execFileSync("bash", [join(REPO, script), ...args], {
          cwd: REPO,
          encoding: "utf8",
          timeout: 240_000,
          maxBuffer: 64 * 1024 * 1024,
          env,
        }),
      };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  const baseEnv = (): Record<string, string | undefined> => {
    const e: Record<string, string | undefined> = { ...process.env };
    for (const k of [
      "RELAY_DB_URL",
      "RELAY_BACKUP_SCHEMA",
      "RELAY_RESTORE_ISOLATED",
      "RELAY_RESTORE_CONTAINER",
      "RELAY_PG_CONTAINER",
    ])
      delete e[k];
    return e;
  };

  /** 真实 preflight 工具指向隔离实例(与 CLI --env-file/--pg-container 同一探针路径;schema 显式指向目标)。 */
  const runPreflightOn = async (dbName: string): Promise<Awaited<ReturnType<typeof runPreflight>>> => {
    const envPath = join(tmpRoot, `preflight-env.env`);
    // 10 必需键占位值(合成,零真实凭据;RELAY_DB_URL=隔离恢复库真实地址;RELAY_DB_SCHEMA=目标 schema)
    const lines = [
      `RELAY_DB_URL=postgresql://postgres:${password}@127.0.0.1:${rstPort}/${dbName}`,
      `RELAY_DB_SCHEMA=${TARGET}`,
      "RELAY_PI_PROVIDER=d10-sim",
      "RELAY_PI_MODEL=d10-sim",
      "RELAY_PI_API_KEY=d10-synthetic-placeholder",
      "RELAY_PI_BASE_URL=http://127.0.0.1:9",
      "RELAY_WEB_HOST=127.0.0.1",
      "RELAY_WEB_PORT=8787",
      "RELAY_WEB_ALLOW_NON_LOOPBACK=0",
      "RELAY_OPERATORS=d10-sim-operator",
      "",
    ].join("\n");
    writeFileSync(envPath, lines);
    chmodSync(envPath, 0o600);
    const opts = { envPath, pgContainer: rstContainer, schema: TARGET };
    return runPreflight(defaultProbes(opts), opts);
  };

  beforeAll(async () => {
    tmpRoot = markTemp(mkdtempSync(join(tmpdir(), "d10-cutover-")));
    const src = startEphemeralPg({ container: srcContainer, password });
    const rst = startEphemeralPg({ container: rstContainer, password });
    rstPort = rst.hostPort;
    srcUrl = `postgresql://postgres:${password}@127.0.0.1:${src.hostPort}/relayd08`;
    rstBase = `postgresql://postgres:${password}@127.0.0.1:${rstPort}`;
    // 就绪门(08/09 同口径:SELECT 1 重试 90s)
    const ready = new pg.Pool({ connectionString: srcUrl, max: 2 });
    let ok = false;
    let lastErr = "";
    for (let i = 0; i < 90 && !ok; i++) {
      try {
        await ready.query("SELECT 1");
        ok = true;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    await ready.end().catch(() => {});
    if (!ok) throw new Error(`一次性 PG 未就绪(90s;最后错误:${lastErr})`);
    let rstOk = false;
    for (let i = 0; i < 90 && !rstOk; i++) {
      try {
        dexec(rstContainer, ["psql", "-U", "postgres", "-d", "relayd08", "-tA", "-c", "SELECT 1"]);
        rstOk = true;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!rstOk) throw new Error("隔离恢复实例未就绪(90s)");

    // 生产形态镜像:0007 形状(0000..0007 已应用;0008/0009 缺=生产 relay_console 现状)+ 合成数据
    // + 兄弟 schema 干扰物 + public.audit_events 遗留干扰(09 同款形态,合成)
    const admin = new pg.Pool({ connectionString: srcUrl, max: 4 });
    try {
      await admin.query(`CREATE SCHEMA "${TARGET}"`);
      const c = await admin.connect();
      try {
        await applyMigrationRange(c, TARGET, 7);
      } finally {
        c.release();
      }
      const w = await admin.connect();
      try {
        await w.query(`SET search_path TO "${TARGET}"`);
        await w.query(
          `INSERT INTO goals (id, raw_input, budget) VALUES ('goal-d10-1', '目标甲:切换模拟合成数据@10', '{"modelCalls":2,"note":"中文保真"}'::jsonb)`,
        );
        await w.query(
          `INSERT INTO tasks (id, state, priority, allowed_scope, gate_required, max_attempts) VALUES ('task-d10-1', 'SUCCEEDED', 2, '[]'::jsonb, true, 3)`,
        );
        await w.query(
          `INSERT INTO runs (id, task_id, attempt, model_ref, budget, sandbox, outcome, detail) VALUES ('run-d10-1', 'task-d10-1', 1, 'd10/synthetic', '{"reserveCallsPerRun":1}', 'docker', 'SUCCEEDED', '{"sim":true}'::jsonb)`,
        );
        await w.query(
          `INSERT INTO goal_messages (goal_id, actor, kind, content) VALUES ('goal-d10-1', 'USER', 'USER_MESSAGE', '切换前合成消息(中文)')`,
        );
        await w.query(
          `INSERT INTO audit_events (actor, action, task_id, detail) VALUES ('d10', 'D10_AUDIT_1', 'task-d10-1', '{"n":1}'::jsonb)`,
        );
        const sha = (s: string): string => s.repeat(64);
        await w.query(`INSERT INTO candidate_changesets (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope, delivery_state, git_commit_sha, delivered_remote_head)
          VALUES ('cs-d10-1', 'task-d10-1', 'run-d10-1', 1, '${sha("b")}', '${sha("c")}', '${sha("d")}', '["src/a.ts"]'::jsonb, '["src"]'::jsonb, 'DELIVERED', '${sha("e")}', 'remote-head-D10')`);
      } finally {
        w.release();
      }
      await admin.query(`CREATE SCHEMA "${DECOY}"`);
      await admin.query(`CREATE TABLE "${DECOY}".decoy_tbl (id text)`);
      await admin.query(`INSERT INTO "${DECOY}".decoy_tbl VALUES ('D10_DECOY_ROW_MUST_NOT_LEAK')`);
      await admin.query(`CREATE TABLE IF NOT EXISTS public.audit_events (
        seq bigserial PRIMARY KEY, ts timestamptz DEFAULT now() NOT NULL, actor text NOT NULL, action text NOT NULL)`);
      await admin.query(
        `INSERT INTO public.audit_events (actor, action) VALUES ('dbos-leftover', 'D10_DECOY_PUBLIC_LEFTOVER')`,
      );
    } finally {
      await admin.end().catch(() => {});
    }
    backupDir = join(tmpRoot, "backup-d10");
    mkdirSync(backupDir, { recursive: true });
  }, TIMEOUT);

  afterAll(async () => {
    destroyEphemeralPg(srcContainer, (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }));
    destroyEphemeralPg(rstContainer, (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }));
    if (tmpRoot) safeRm(tmpRoot, { roots: [tmpRoot], sentinel: RUN_SENTINEL });
  }, TIMEOUT);

  it(
    "① 目标 schema 备份(09 语义):真跑 backup.sh schema 唯一入口;dump 仅含目标 schema,零兄弟 schema/public 遗留混入;输出零密码(日志脱敏)",
    () => {
      const r = runScript("deploy/backup.sh", [backupDir], {
        ...baseEnv(),
        RELAY_DB_URL: srcUrl,
        RELAY_BACKUP_SCHEMA: TARGET,
        RELAY_PG_CONTAINER: srcContainer,
      });
      expect(r.status, `backup.sh 应成功:${r.out.slice(0, 500)}`).toBe(0);
      expect(r.out).toContain(`schema=${TARGET}`);
      backupStamp = r.out.match(/(\d{8}T\d{6}Z)/)?.[1] ?? "";
      expect(backupStamp).not.toBe("");
      const marker = readFileSync(join(backupDir, `backup-${backupStamp}.done`), "utf8");
      expect(marker).toContain("backup-complete");
      expect(marker).toContain(`schema=${TARGET}`);
      // 产物唯一性 + 校验和
      const files = execFileSync("ls", [backupDir], { encoding: "utf8" }).split("\n").filter(Boolean);
      expect(files.filter((f) => f.startsWith("db-")).length).toBe(1);
      expect(files.filter((f) => f.startsWith("artifacts-manifest-")).length).toBe(1);
      expect(files.filter((f) => f.startsWith("audit-index-")).length).toBe(1);
      execFileSync("sha256sum", ["-c", `checksums-${backupStamp}.sha256`], {
        cwd: backupDir,
        stdio: "ignore",
        timeout: 30_000,
      });
      // manifest.targetSchema=恢复核对目标身份唯一来源(09)
      const manifest = JSON.parse(readFileSync(join(backupDir, `artifacts-manifest-${backupStamp}.json`), "utf8")) as {
        targetSchema?: string;
      };
      expect(manifest.targetSchema).toBe(TARGET);
      // dump 作用域:目标 schema 16 表(0007 形状),零 DECOY/public 混入
      const dump = readFileSync(join(backupDir, `db-${backupStamp}.sql`), "utf8");
      expect(dump.match(new RegExp(`CREATE TABLE ${TARGET}\\.`, "g"))?.length).toBe(16);
      expect(dump).toContain(`CREATE SCHEMA ${TARGET}`);
      expect(dump).not.toContain(`CREATE SCHEMA ${DECOY}`);
      expect(dump).not.toContain("D10_DECOY_ROW_MUST_NOT_LEAK");
      expect(dump).not.toContain("D10_DECOY_PUBLIC_LEFTOVER");
      expect(dump).toContain("D10_AUDIT_1");
      expect(dump).toContain("目标甲:切换模拟合成数据@10");
      // 日志脱敏:输出零密码
      expect(r.out).not.toContain(password);
    },
    TIMEOUT,
  );

  it(
    "② 隔离恢复(09R 身份门):真跑 restore-verify.sh(源=src 实例,目标=rst 实例,身份证明通过)→ 恢复库=备份时点 0007 形状(回退目标形状)+ 合成行保真 + 零 decoy 混入 + 输出零密码",
    () => {
      const r = runScript("deploy/restore-verify.sh", [backupDir, rstBase], {
        ...baseEnv(),
        RELAY_DB_URL: srcUrl,
        RELAY_RESTORE_ISOLATED: "1",
        RELAY_RESTORE_CONTAINER: rstContainer,
      });
      expect(r.status, `restore-verify.sh 应成功:${r.out.slice(0, 800)}`).toBe(0);
      expect(r.out).toContain("身份证明通过");
      expect(r.out).toContain("核对通过");
      restoreDb1 = r.out.match(/目标库:(relay_restore_v\S+)/)?.[1] ?? "";
      expect(restoreDb1).not.toBe("");
      restoreDbUrl1 = `${rstBase}/${restoreDb1}`;
      // 恢复库=备份时点形状:0007 形状(g8/g9=0/0)+ 合成数据保真(含中文)+ 零 decoy
      const g = (q: string): string =>
        dexec(rstContainer, ["psql", "-U", "postgres", "-d", restoreDb1, "-tA", "-c", q]).trim();
      expect(
        g(
          `SELECT count(*) FROM information_schema.columns WHERE table_schema='${TARGET}' AND table_name='goal_messages' AND column_name='execution_request'`,
        ),
      ).toBe("0");
      expect(
        g(
          `SELECT count(*) FROM information_schema.columns WHERE table_schema='${TARGET}' AND table_name='tasks' AND column_name='abort_requested_at'`,
        ),
      ).toBe("0");
      expect(g(`SELECT count(*) FROM information_schema.tables WHERE table_schema='${TARGET}'`)).toBe("16");
      expect(g(`SELECT raw_input FROM "${TARGET}".goals WHERE id='goal-d10-1'`)).toBe("目标甲:切换模拟合成数据@10");
      expect(g(`SELECT count(*) FROM information_schema.schemata WHERE schema_name='${DECOY}'`)).toBe("0");
      expect(
        g(`SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='audit_events'`),
      ).toBe("0");
      expect(r.out).not.toContain(password);
    },
    TIMEOUT,
  );

  it(
    "③ 0008/0009 增量(08 工具真跑):切换前 preflight db_migrations=FAIL → plan(真实迁移文件 SQL)→ apply(后验全绿/旧行回填 false)→ 重入 skipped_already → 切换后 preflight db_migrations=PASS 且裁决≠GO(其余 UNKNOWN 项如实呈现)",
    async () => {
      const pool = new pg.Pool({ connectionString: restoreDbUrl1, max: 4 });
      try {
        // 切换前 preflight(真实工具):db_migrations FAIL(缺 0008/0009)
        const before = await runPreflightOn(restoreDb1);
        const beforeMig = before.results.find((x) => x.id === "db_migrations");
        expect(beforeMig?.status).toBe("FAIL");
        expect(beforeMig?.detail ?? "").toContain("0008");
        expect(beforeMig?.detail ?? "").toContain("0009");
        const beforeTables = before.results.find((x) => x.id === "db_schema_tables");
        expect(beforeTables?.status).toBe("PASS"); // 0007 形状=16 表齐备

        // 守卫:恢复库连接串满足 apply 授权面(p01a_ 前缀/回环/显式端口)
        assertApplyTargetAuthorized(TARGET, restoreDbUrl1);
        // 形状:incremental_upgrade_available,pending=[0008,0009]
        const shape = await detectMigrationShape(pool, TARGET);
        expect(shape.verdict).toBe("incremental_upgrade_available");
        expect(shape.appliedTags).toEqual([]);
        expect(shape.pendingTags).toEqual(["0008_goal_messages_execution_request", "0009_tasks_abort_requested"]);
        // 计划:2 步,SQL 取自真实迁移文件,回滚材料在位
        const plan = await buildIncrementalPlan(shape);
        expect(plan.steps.length).toBe(2);
        expect(plan.steps.every((s) => s.statements.length > 0)).toBe(true);
        expect(plan.rollbackNote.length).toBeGreaterThan(0);
        // 应用:逐步事务+后验全绿
        const report = await applyIncrementalMigration(pool, TARGET, { url: restoreDbUrl1 });
        expect(report.ok).toBe(true);
        expect(report.steps.map((s) => `${s.tag}:${s.status}`)).toEqual([
          "0008_goal_messages_execution_request:applied",
          "0009_tasks_abort_requested:applied",
        ]);
        const v = await verifyPostMigrationState(pool, TARGET);
        expect(v.ok, `后验失败:${v.failures.join(";")}`).toBe(true);
        // 切换后 preflight:db_migrations PASS;裁决≠GO(其余 UNKNOWN 项如实呈现——迁移只清 FAIL 的 db_migrations)
        const after = await runPreflightOn(restoreDb1);
        const afterMig = after.results.find((x) => x.id === "db_migrations");
        expect(afterMig?.status).toBe("PASS");
        expect(after.verdict).not.toBe("GO");
        const unknownIds = after.results.filter((x) => x.status === "UNKNOWN").map((x) => x.id);
        expect(unknownIds).toContain("evidence_checks_config"); // Gate 配置=用户 D3 决策项,不因迁移消失
        expect(unknownIds).toContain("process_vs_head"); // 线上旧进程=真实重启后才消解
        expect(unknownIds).toContain("egress_stack"); // egress 自愈=真实重启后首拍
        // 重入:重复 apply ⇒ skipped_already(不盲撞)
        const again = await applyIncrementalMigration(pool, TARGET, { url: restoreDbUrl1 });
        expect(again.ok).toBe(true);
        expect(again.steps.map((s) => `${s.tag}:${s.status}`)).toEqual([
          "0008_goal_messages_execution_request:skipped_already",
          "0009_tasks_abort_requested:skipped_already",
        ]);
      } finally {
        await pool.end().catch(() => {});
      }
    },
    TIMEOUT,
  );

  it(
    "④ 断点/半迁移与回滚条件:再次恢复同一备份(回滚路径=Runbook「schema 回退统一走备份恢复」演练形态)→ fail-at 0009 注入 ⇒ 断点如实(0008 已应用/0009 待执行,不假 GO)→ 续跑完成;迁移后旧代码形态写入成功且默认 false(回退代码无需回滚 schema)",
    async () => {
      // 回滚路径:同一备份再次隔离恢复
      const r = runScript("deploy/restore-verify.sh", [backupDir, rstBase], {
        ...baseEnv(),
        RELAY_DB_URL: srcUrl,
        RELAY_RESTORE_ISOLATED: "1",
        RELAY_RESTORE_CONTAINER: rstContainer,
      });
      expect(r.status, `二次恢复应成功:${r.out.slice(0, 800)}`).toBe(0);
      const restoreDb2 = r.out.match(/目标库:(relay_restore_v\S+)/)?.[1] ?? "";
      expect(restoreDb2).not.toBe("");
      expect(restoreDb2).not.toBe(restoreDb1);
      const restoreDbUrl2 = `${rstBase}/${restoreDb2}`;
      const pool = new pg.Pool({ connectionString: restoreDbUrl2, max: 4 });
      try {
        // 断点注入:0009 步失败 ⇒ 0008 已 COMMIT,0009 未应用(真实半迁移状态)
        let halfErr = "";
        try {
          await applyIncrementalMigration(pool, TARGET, {
            url: restoreDbUrl2,
            failAtTag: "0009_tasks_abort_requested",
          });
        } catch (err) {
          halfErr = err instanceof Error ? err.message : String(err);
        }
        expect(halfErr).not.toBe("");
        const half = await detectMigrationShape(pool, TARGET);
        expect(half.verdict).toBe("incremental_upgrade_available"); // 如实"待升级",不假 GO
        expect(half.appliedTags).toEqual(["0008_goal_messages_execution_request"]);
        expect(half.pendingTags).toEqual(["0009_tasks_abort_requested"]);
        // 续跑:从断点完成,不重复已应用步骤
        const resumed = await applyIncrementalMigration(pool, TARGET, { url: restoreDbUrl2 });
        expect(resumed.ok).toBe(true);
        expect(resumed.steps.map((s) => `${s.tag}:${s.status}`)).toEqual([
          "0008_goal_messages_execution_request:skipped_already",
          "0009_tasks_abort_requested:applied",
        ]);
        expect((await verifyPostMigrationState(pool, TARGET)).ok).toBe(true);
        // 回滚条件:迁移后旧代码形态 INSERT(不引用新列)成功,默认回填 false ⇒ 回退代码无需回滚 schema
        const w = await pool.connect();
        try {
          await w.query(`SET search_path TO "${TARGET}"`);
          await w.query(
            `INSERT INTO goal_messages (goal_id, actor, kind, content) VALUES ((SELECT id FROM goals LIMIT 1), 'USER', 'USER_MESSAGE', '迁移后旧行为写入(代码回退兼容@10)')`,
          );
        } finally {
          w.release();
        }
        const backfilled = await pool.query(
          `SELECT count(*)::int AS n FROM "${TARGET}".goal_messages WHERE execution_request = false`,
        );
        expect(Number(backfilled.rows[0]?.["n"] ?? 0)).toBeGreaterThan(0);
        // 备份校验可重放(回滚基准物完好)
        execFileSync("sha256sum", ["-c", `checksums-${backupStamp}.sha256`], {
          cwd: backupDir,
          stdio: "ignore",
          timeout: 30_000,
        });
      } finally {
        await pool.end().catch(() => {});
      }
    },
    TIMEOUT,
  );

  it(
    "⑤ 功能性 Gate 配置通过/失败(resolveEvidenceChecks 真校验):sample 合法通过;非法变异 fail-closed 拒绝;未配置=undefined(保守停机路径)。docker 检查执行器真跑由既有 evidence-gate-rehearsal 3/3 承担(不重复)",
    () => {
      // 合法:仓库 sample(样例,非生产取值)经真实校验通过
      const sample = readFileSync(join(REPO, "deploy/evidence-checks.sample.json"), "utf8");
      const checks = resolveEvidenceChecks(sample);
      expect(Array.isArray(checks) && checks.length > 0).toBe(true);
      expect(checks?.[0]?.kind).toBe("deterministic_test");
      // 非法变异 fail-closed(与 08 Gate 演练同矩阵形态)
      expect(() => resolveEvidenceChecks("{not-json")).toThrow(/非法 JSON/);
      expect(() => resolveEvidenceChecks("[]")).toThrow(/空数组/);
      expect(() => resolveEvidenceChecks('[{"kind":"unit_test","command":["true"]}]')).toThrow(/功能性证据/);
      expect(() => resolveEvidenceChecks('[{"kind":"deterministic_test","command":"ls"}]')).toThrow(/非空字符串数组/);
      expect(() => resolveEvidenceChecks('[{"kind":"deterministic_test","command":["true"],"timeoutMs":5}]')).toThrow(
        /1000~600000/,
      );
      // 未配置 ⇒ undefined ⇒ Gate 保守停机(functional_evidence_unconfigured→NEEDS_DECISION;fail-closed 安全)
      expect(resolveEvidenceChecks(undefined)).toBeUndefined();
      expect(resolveEvidenceChecks("")).toBeUndefined();
    },
    TIMEOUT,
  );
});
