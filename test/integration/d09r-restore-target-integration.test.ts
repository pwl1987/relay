// RELAY-RESTORE-TARGET-09R D 项:恢复目标真实身份校验的真实隔离回归(一次性双实例,零生产触碰)。
// 红态(对 8368cb1 原样脚本,假执行器):p0-mvp/backup-integrity-09/evidence/red09r-r1~r4.log。
// 本套件在真实一次性实例上证明(与 d09 主链互补;主链已含身份门全链正例):
//   ① 同实例别名/误指真值层拒绝(源实例经 bridge IP 直连形态:实例键不同 ⇒ 走探针层 ⇒ 服务端身份相同 ⇒ 拒绝);
//   ② docker 绑定错位真杀(RESTORE_RESTORE_CONTAINER 指向源容器/生产形态容器名 ⇒ 发布端口不一致 ⇒ DDL 前拒绝);
//   ③ 容器名同名欺骗拒绝(显式 RELAY_PG_CONTAINER 与恢复容器同名);
//   ④ 源/目标身份不可证 ⇒ 保守拒绝(真 ECONNREFUSED);
//   ⑤ 探针层正例(bridge IP 形态指向真实隔离目标 ⇒ 通过并完成恢复;证明探针层不过度拒绝)。
// 断言按分支自适应:VM80 宿主无 psql ⇒ restore-verify.sh docker 分支;CI/其他宿主有 psql ⇒ host 分支。
// relay-p000-pg 仅允许 docker inspect 元数据读取(只读),零 exec、零 DB 连接。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { dockerAvailable } from "../../src/runtime/sandbox.ts";
import { markTemp, safeRm, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";
import { startEphemeralPg, destroyEphemeralPg } from "./d08-ephemeral-pg.ts";

const dockerOk = dockerAvailable();
const TIMEOUT = 300_000;
const REPO = join(import.meta.dirname, "../..");
const hostHasPsql = (() => {
  try {
    execFileSync("bash", ["-c", "command -v psql"], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dockerOk)("RELAY-RESTORE-TARGET-09R:恢复目标身份真实隔离回归(一次性双实例)", () => {
  const uid = randomUUID().slice(0, 8);
  const srcContainer = `relay-test-d09r-src-${uid}`;
  const rstContainer = `relay-test-d09r-rst-${uid}`;
  let tmpRoot = "";
  let srcPort = "";
  let srcUrl = "";
  let rstPort = "";
  let rstBase = "";
  let srcBridgeIp = "";
  let rstBridgeIp = "";
  let backupDir = "";
  const password = `d09r-${uid}`;

  const dexec = (container: string, args: string[]): string =>
    execFileSync("docker", ["exec", container, ...args], { encoding: "utf8", timeout: 120_000 });

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

  const bridgeIp = (container: string): string =>
    execFileSync("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container], {
      encoding: "utf8",
    }).trim();

  /** 可达性探针:pg 直连(身份探针同路径;零 DDL)。 */
  const reachable = async (url: string): Promise<boolean> => {
    try {
      const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
      await pool.query("SELECT 1");
      await pool.end().catch(() => {});
      return true;
    } catch {
      return false;
    }
  };

  const runScript = (
    backup: string,
    restoreUrl: string,
    env: Record<string, string | undefined>,
  ): { status: number; out: string } => {
    try {
      return {
        status: 0,
        out: execFileSync("bash", [join(REPO, "deploy/restore-verify.sh"), backup, restoreUrl], {
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
    delete e.RELAY_DB_URL;
    delete e.RELAY_RESTORE_ISOLATED;
    delete e.RELAY_RESTORE_CONTAINER;
    delete e.RELAY_PG_CONTAINER;
    return e;
  };

  /** 合成但满足 check.mjs 的有效备份目录(schema 含 candidate_changesets/audit_events 空表;delivered/审计均空)。 */
  const mkValidBackup = (): void => {
    backupDir = join(tmpRoot, "bk-d09r");
    mkdirSync(backupDir, { recursive: true });
    const stamp = "20260101T000000Z";
    writeFileSync(
      join(backupDir, `backup-${stamp}.done`),
      `backup-complete\nstamp=${stamp}\nschema=p01a_red_d09r\ngenerated_at=2026-01-01T00:00:00Z\n`,
    );
    writeFileSync(
      join(backupDir, `db-${stamp}.sql`),
      [
        "CREATE SCHEMA p01a_red_d09r;",
        "CREATE TABLE p01a_red_d09r.candidate_changesets (id text, task_id text, git_commit_sha text, delivered_remote_head text, delivery_state text);",
        "CREATE TABLE p01a_red_d09r.audit_events (seq bigint, ts timestamptz, actor text, action text);",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(backupDir, `artifacts-manifest-${stamp}.json`),
      `{"targetSchema":"p01a_red_d09r","delivered":[],"generatedAt":"2026-01-01T00:00:00Z"}\n`,
    );
    writeFileSync(join(backupDir, `audit-index-${stamp}.txt`), "");
    execFileSync("bash", [
      "-c",
      `cd "${backupDir}" && sha256sum "db-${stamp}.sql" "artifacts-manifest-${stamp}.json" "audit-index-${stamp}.txt" "backup-${stamp}.done" > "checksums-${stamp}.sha256"`,
    ]);
  };

  beforeAll(async () => {
    tmpRoot = markTemp(mkdtempSync(join(tmpdir(), "d09r-target-")));
    const src = startEphemeralPg({ container: srcContainer, password });
    const rst = startEphemeralPg({ container: rstContainer, password });
    srcPort = src.hostPort;
    rstPort = rst.hostPort;
    srcUrl = `postgresql://postgres:${password}@127.0.0.1:${srcPort}/relayd08`;
    rstBase = `postgresql://postgres:${password}@127.0.0.1:${rstPort}`;
    // 就绪门(与 08/09 同口径:SELECT 1 重试 90s)
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      ready = await reachable(srcUrl);
      if (!ready) await new Promise((r) => setTimeout(r, 2_000));
    }
    if (!ready) throw new Error(`源一次性实例 90s 未就绪:${srcContainer}`);
    expect(await reachable(rstBase)).toBe(true);
    srcBridgeIp = bridgeIp(srcContainer);
    rstBridgeIp = bridgeIp(rstContainer);
    mkValidBackup();
  }, TIMEOUT);

  afterAll(async () => {
    destroyEphemeralPg(srcContainer, (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }));
    destroyEphemeralPg(rstContainer, (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }));
    if (tmpRoot) safeRm(tmpRoot, { roots: [tmpRoot], sentinel: RUN_SENTINEL });
  }, TIMEOUT);

  it(
    "① 真值层别名杀:RESTORE_URL 指向源实例 bridge IP(实例键不同 ⇒ 探针层 ⇒ 服务端身份相同 ⇒ 拒绝;docker 分支则在回环门前拒绝)",
    async () => {
      const srcBefore = restoreDbNames(srcContainer).length;
      const rstBefore = restoreDbNames(rstContainer).length;
      const bridgeUrl = `postgresql://postgres:${password}@${srcBridgeIp}:5432`;
      const bridgeReachable = await reachable(bridgeUrl);
      const r = runScript(backupDir, bridgeUrl, {
        ...baseEnv(),
        RELAY_DB_URL: srcUrl,
        RELAY_RESTORE_ISOLATED: "1",
        ...(hostHasPsql ? {} : { RELAY_RESTORE_CONTAINER: rstContainer }),
      });
      expect(r.status, `应拒绝:${r.out.slice(0, 600)}`).not.toBe(0);
      if (!hostHasPsql) {
        // docker 分支:RESTORE_URL 非回环 ⇒ 先于探针在绑定门拒绝(真值层由单测 pg 桩+CI host 分支承担)
        expect(r.out).toContain("回环");
      } else if (bridgeReachable) {
        // host 分支 + bridge 可达:探针层真跑 —— 同一物理实例由服务端身份识别(不依赖连接串文本)
        expect(r.out).toContain("同一物理实例");
      } else {
        // host 分支 + bridge 不可达(该环境 host→bridge 隔离):探针失败 ⇒ 保守拒绝(如实断言)
        expect(r.out).toContain("恢复目标实例身份不可证");
      }
      expect(restoreDbNames(srcContainer).length).toBe(srcBefore); // 源实例零 DDL
      expect(restoreDbNames(rstContainer).length).toBe(rstBefore);
    },
    TIMEOUT,
  );

  it(
    "② docker 绑定错位真杀:RELAY_RESTORE_CONTAINER 指向源容器(VM80/docker 分支:发布端口不一致 ⇒ DDL 前拒绝)",
    async () => {
      const srcBefore = restoreDbNames(srcContainer).length;
      const rstBefore = restoreDbNames(rstContainer).length;
      const r = runScript(backupDir, rstBase, {
        ...baseEnv(),
        RELAY_DB_URL: srcUrl,
        RELAY_RESTORE_ISOLATED: "1",
        RELAY_RESTORE_CONTAINER: srcContainer, // 错位:指向备份源容器
      });
      if (hostHasPsql) {
        // host 分支不使用容器环境变量,RESTORE_URL 为真实隔离目标 ⇒ 正常恢复完成(行为如实,零误用)
        expect(r.status, `host 分支应成功:${r.out.slice(0, 600)}`).toBe(0);
        expect(r.out).toContain("身份证明通过");
        const rstDb = r.out.match(/目标库:(relay_restore_v\S+)/)?.[1] ?? "";
        expect(rstDb).not.toBe("");
        expect(
          dexec(rstContainer, [
            "psql",
            "-U",
            "postgres",
            "-d",
            rstDb,
            "-tA",
            "-c",
            "SELECT count(*) FROM information_schema.schemata WHERE schema_name='p01a_red_d09r'",
          ]).trim(),
        ).toBe("1");
        expect(
          dexec(rstContainer, ["psql", "-U", "postgres", "-c", `DROP DATABASE IF EXISTS ${rstDb}`, "-q"]),
        ).toBeDefined();
      } else {
        expect(r.status, `docker 分支应拒绝:${r.out.slice(0, 600)}`).not.toBe(0);
        expect(r.out).toContain("发布端口");
        expect(r.out).toContain("不一致");
        expect(restoreDbNames(srcContainer).length).toBe(srcBefore);
        expect(restoreDbNames(rstContainer).length).toBe(rstBefore);
      }
    },
    TIMEOUT,
  );

  it(
    "③ 生产形态容器名误指:RELAY_RESTORE_CONTAINER=relay-p000-pg(仅 docker inspect 元数据,零 exec 零 DB 连接)⇒ 绑定门拒绝",
    async () => {
      if (hostHasPsql) {
        // host 分支不读容器名 ⇒ 该误指形态不适用(记录事实,断言正恢复不受影响)
        const r = runScript(backupDir, rstBase, {
          ...baseEnv(),
          RELAY_DB_URL: srcUrl,
          RELAY_RESTORE_ISOLATED: "1",
          RELAY_RESTORE_CONTAINER: "relay-p000-pg",
        });
        expect(r.status).toBe(0);
        const rstDb = r.out.match(/目标库:(relay_restore_v\S+)/)?.[1] ?? "";
        expect(
          dexec(rstContainer, ["psql", "-U", "postgres", "-c", `DROP DATABASE IF EXISTS ${rstDb}`, "-q"]),
        ).toBeDefined();
        return;
      }
      const rstBefore = restoreDbNames(rstContainer).length;
      const r = runScript(backupDir, rstBase, {
        ...baseEnv(),
        RELAY_DB_URL: srcUrl,
        RELAY_RESTORE_ISOLATED: "1",
        RELAY_RESTORE_CONTAINER: "relay-p000-pg",
      });
      expect(r.status, `应拒绝:${r.out.slice(0, 600)}`).not.toBe(0);
      expect(r.out).toContain("发布端口");
      expect(r.out).toContain("不一致"); // relay-p000-pg 发布 55433 ≠ rstPort
      expect(restoreDbNames(rstContainer).length).toBe(rstBefore);
    },
    TIMEOUT,
  );

  it(
    "④ 容器名同名欺骗(显式 RELAY_PG_CONTAINER=恢复容器)⇒ docker 分支 DDL 前拒绝",
    async () => {
      if (hostHasPsql) return; // host 分支无容器绑定环节;欺骗面由单测静态契约钉死
      const srcBefore = restoreDbNames(srcContainer).length;
      const r = runScript(backupDir, rstBase, {
        ...baseEnv(),
        RELAY_DB_URL: srcUrl,
        RELAY_RESTORE_ISOLATED: "1",
        RELAY_RESTORE_CONTAINER: srcContainer,
        RELAY_PG_CONTAINER: srcContainer,
      });
      expect(r.status).not.toBe(0);
      expect(r.out).toContain("容器名欺骗");
      expect(restoreDbNames(srcContainer).length).toBe(srcBefore);
    },
    TIMEOUT,
  );

  it(
    "⑤ 源实例身份不可证(RELAY_DB_URL 不可达端口,真 ECONNREFUSED)⇒ 保守拒绝且双实例零 DDL(两分支一致)",
    async () => {
      const srcBefore = restoreDbNames(srcContainer).length;
      const rstBefore = restoreDbNames(rstContainer).length;
      const r = runScript(backupDir, rstBase, {
        ...baseEnv(),
        RELAY_DB_URL: `postgresql://postgres:x@127.0.0.1:1/none`,
        RELAY_RESTORE_ISOLATED: "1",
        ...(hostHasPsql ? {} : { RELAY_RESTORE_CONTAINER: rstContainer }),
      });
      expect(r.status, `应拒绝:${r.out.slice(0, 600)}`).not.toBe(0);
      expect(r.out).toContain("源实例身份不可证");
      expect(restoreDbNames(srcContainer).length).toBe(srcBefore);
      expect(restoreDbNames(rstContainer).length).toBe(rstBefore);
    },
    TIMEOUT,
  );

  it(
    "⑥ 探针层正例:RESTORE_URL 经目标 bridge IP(实例键不同 ⇒ 探针层真跑 ⇒ 身份不同 ⇒ 通过并完成恢复)",
    async () => {
      if (!hostHasPsql) {
        // docker 分支:RESTORE_URL 必须回环(绑定门),bridge IP 形态被拒 —— 正例由主链(rstBase 回环)承担
        const r = runScript(backupDir, `postgresql://postgres:${password}@${rstBridgeIp}:5432`, {
          ...baseEnv(),
          RELAY_DB_URL: srcUrl,
          RELAY_RESTORE_ISOLATED: "1",
          RELAY_RESTORE_CONTAINER: rstContainer,
        });
        expect(r.status).not.toBe(0);
        expect(r.out).toContain("回环");
        return;
      }
      // host 分支:非回环 RESTORE_URL 合法(直连),探针层证明两实例身份不同后放行
      const rstBefore = restoreDbNames(rstContainer).length;
      const url = `postgresql://postgres:${password}@${rstBridgeIp}:5432`;
      if (!(await reachable(url))) {
        // 该环境 host→bridge 直连不可达:拒绝路径即正确行为(如实断言,不虚构通过)
        const r = runScript(backupDir, url, { ...baseEnv(), RELAY_DB_URL: srcUrl, RELAY_RESTORE_ISOLATED: "1" });
        expect(r.status).not.toBe(0);
        expect(r.out).toContain("恢复目标实例身份不可证");
        return;
      }
      const r = runScript(backupDir, url, { ...baseEnv(), RELAY_DB_URL: srcUrl, RELAY_RESTORE_ISOLATED: "1" });
      expect(r.status, `bridge IP 正例应成功:${r.out.slice(0, 600)}`).toBe(0);
      expect(r.out).toContain("身份证明通过");
      expect(r.out).toContain("核对通过");
      const rstDb = r.out.match(/目标库:(relay_restore_v\S+)/)?.[1] ?? "";
      expect(rstDb).not.toBe("");
      expect(restoreDbNames(rstContainer).length).toBe(rstBefore + 1);
      expect(
        dexec(rstContainer, [
          "psql",
          "-U",
          "postgres",
          "-d",
          rstDb,
          "-tA",
          "-c",
          "SELECT count(*) FROM information_schema.schemata WHERE schema_name='p01a_red_d09r'",
        ]).trim(),
      ).toBe("1");
      expect(
        dexec(rstContainer, ["psql", "-U", "postgres", "-c", `DROP DATABASE IF EXISTS ${rstDb}`, "-q"]),
      ).toBeDefined();
    },
    TIMEOUT,
  );
});
