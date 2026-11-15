// RELAY-RESTORE-TARGET-09R:恢复目标真实身份校验。
// 红态证据(对 8368cb1 原样 restore-verify.sh;假执行器拦截,零真实 DB/容器操作):
//   p0-mvp/backup-integrity-09/evidence/red09r-r1.log   同实例别名绕过(127.0.0.1 vs localhost,DROP argv 已发往别名地址)
//   p0-mvp/backup-integrity-09/evidence/red09r-r2.log   docker 容器错位(RESTORE_URL 无效主机被无视,argv 发往 relay-p000-pg)
//   p0-mvp/backup-integrity-09/evidence/red09r-r3.log   端口缺省别名绕过(localhost 默认 5432)
//   p0-mvp/backup-integrity-09/evidence/red09r-r4.log   任意 RELAY_RESTORE_CONTAINER 被盲信
// 红态可复核:evidence/red09r-harness/(驱动脚本+合成备份构造器;封闭 PATH=假执行器,真 docker/psql 不可达)。
// 本套件钉死修后语义:任何 DROP/CREATE/导入之前必须证明目标≠备份源实例(文本快速门+docker 执行面绑定+
// 服务端真值双探针);所有拒绝路径断言零 DDL 调用(psql/docker 危险调用计数=0)。纯单测,零 docker 依赖。
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  instanceKey,
  isLoopbackHost,
  parseDbUrl,
  readInspectMapping,
  verifyRestoreTarget,
} from "../../deploy/restore-target-verify.mjs";

const deployDir = join(import.meta.dirname, "../../deploy");
const REPO = join(import.meta.dirname, "../..");
const src = (f: string): string => readFileSync(join(deployDir, f), "utf8");

/** 剥掉 bash 注释后的脚本正文(静态契约作用于可执行行)。 */
function codeOf(f: string): string {
  return src(f)
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

/** 构造可注入 pg 桩:探针返回给定身份(或抛错)。 */
function stubPg(
  source: { startTime: string; port: number } | Error,
  target?: { startTime: string; port: number } | Error,
) {
  const mk = (r: { startTime: string; port: number } | Error | undefined) => ({
    Pool: class {
      async query(sql: string) {
        if (sql.includes("inet_server_addr")) {
          if (r instanceof Error) throw r;
          if (r === undefined) throw new Error("unexpected probe");
          return { rows: [{ start_time: r.startTime, server_port: r.port, server_addr: "127.0.0.1" }] };
        }
        throw new Error(`stub 只处理身份探针,收到:${sql}`);
      }
      async end() {}
    },
  });
  let calls = 0;
  const first = mk(source);
  const second = mk(target ?? source);
  return {
    pgModule: {
      get Pool() {
        calls += 1;
        return calls === 1 ? first.Pool : second.Pool;
      },
    },
    calls: () => calls,
  };
}

describe("RELAY-RESTORE-TARGET-09R:restore-verify.sh 静态契约(修后语义钉死)", () => {
  it("身份校验先于任何 DDL(restore-target-verify.mjs 位于首个 DROP/CREATE 之前)", () => {
    const c = codeOf("restore-verify.sh");
    const gatePos = c.indexOf("restore-target-verify.mjs");
    const ddlPos = c.indexOf("DROP DATABASE");
    const createPos = c.indexOf("CREATE DATABASE");
    expect(gatePos).toBeGreaterThan(-1);
    expect(ddlPos).toBeGreaterThan(gatePos);
    expect(createPos).toBeGreaterThan(gatePos);
  });

  it("RELAY_DB_URL 必须显式提供(无法提供源实例身份 ⇒ fail-closed,不再是无声跳过)", () => {
    const c = codeOf("restore-verify.sh");
    expect(c).toMatch(/\[ -n "\$\{RELAY_DB_URL:-\}" \] \|\| refuse/);
  });

  it("docker 回退分支:docker inspect 恢复容器 + 绑定材料传入身份校验(exec 执行面身份探针须与 RESTORE_URL 探针一致)", () => {
    const c = codeOf("restore-verify.sh");
    expect(c).toMatch(/docker inspect "\$RC" > "\$TMPD\/rest-inspect\.json"/);
    expect(c).toMatch(/--container-inspect-json "\$TMPD\/rest-inspect\.json"/);
    expect(c).toContain('[ "$RELAY_PG_CONTAINER" = "$RC" ] && refuse'); // 容器名欺骗(显式源容器与恢复容器同名)
    expect(c).toMatch(/SELECT pg_postmaster_start_time\(\)::text/); // exec 探针
    expect(c).toMatch(/"\$EXEC_TS" = "\$TARGET_START_TIME" \]/); // 绑定比对
  });

  it("身份校验工具零原始数据查询(仅服务端身份字段;消息脱敏)", () => {
    const mjs = src("restore-target-verify.mjs");
    expect(mjs).toMatch(/pg_postmaster_start_time/);
    expect(mjs).toMatch(/inet_server_port/);
    expect(mjs).not.toMatch(/SELECT \* FROM/);
    expect(mjs).not.toMatch(/candidate_changesets|audit_events|goals/);
    expect(mjs).toMatch(/redactDbUrl/);
  });

  it("EXIT trap 保留:临时目录(inspect 材料)与失败恢复库清理均在", () => {
    const c = codeOf("restore-verify.sh");
    expect(c).toMatch(/trap cleanup_tmp EXIT/);
    expect(c).toMatch(/cleanup_tmp # EXIT trap 已被本函数替换/);
    expect(c).toMatch(/trap cleanup_db EXIT/);
  });
});

describe("RELAY-RESTORE-TARGET-09R:URL 规范化纯逻辑(红态 R1/R3 形态必须被判同实例)", () => {
  it("parseDbUrl:回环/IPv6 括号/默认端口/查询串/片段/尾斜杠", () => {
    expect(parseDbUrl("postgresql://u:p@LocalHost:55433/db?x=1#f")).toEqual({
      scheme: "postgresql",
      host: "localhost",
      port: 55433,
      dbname: "db",
    });
    expect(parseDbUrl("postgresql://u@127.0.0.1:5433")).toEqual({
      scheme: "postgresql",
      host: "127.0.0.1",
      port: 5433,
      dbname: "",
    });
    expect(parseDbUrl("postgresql://u@[::1]:5432/db/")).toEqual({
      scheme: "postgresql",
      host: "::1",
      port: 5432,
      dbname: "db",
    });
    expect(parseDbUrl("postgresql://u@10.30.5.80")).toEqual({
      scheme: "postgresql",
      host: "10.30.5.80",
      port: 5432,
      dbname: "",
    });
    expect(parseDbUrl("mysql://u@h/db")).toBeNull();
    // 无 host 形态("postgresql://db")按 WHATWG 解析 host="db" — 解析层放行,由探针层连接失败兜底拒绝
    expect(parseDbUrl("postgresql://db")).toEqual({ scheme: "postgresql", host: "db", port: 5432, dbname: "" });
    expect(parseDbUrl("")).toBeNull();
    expect(parseDbUrl("not a url")).toBeNull();
  });

  it("isLoopbackHost:localhost/127.x/::1 为回环;非回环地址为否", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.9.9.9")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("10.30.5.80")).toBe(false);
    expect(isLoopbackHost("172.17.0.2")).toBe(false);
    expect(isLoopbackHost("example.invalid")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });

  it("instanceKey:同实例别名族折叠(红态 R1/R3);不同端口/非回环 host 区分", () => {
    expect(instanceKey("postgresql://demo@127.0.0.1:55433/relayp000")).toBe("loopback:55433");
    expect(instanceKey("postgresql://demo@localhost:55433")).toBe("loopback:55433"); // R1 形态 ⇒ 相等 ⇒ 快速门拒绝
    expect(instanceKey("postgresql://demo@localhost")).toBe("loopback:5432"); // R3 形态(默认端口)
    expect(instanceKey("postgresql://demo@127.0.0.1:5432/db")).toBe("loopback:5432"); // 与上相等 ⇒ 拒绝
    expect(instanceKey("postgresql://demo@[::1]:55433")).toBe("loopback:55433");
    expect(instanceKey("postgresql://demo@127.0.0.1:55434")).toBe("loopback:55434"); // 不同端口 ⇒ 进入探针层
    expect(instanceKey("postgresql://demo@10.30.5.80:55433/db")).toBe("10.30.5.80:55433");
    expect(instanceKey("postgresql://demo@10.30.5.80:55433/db?x=1")).toBe("10.30.5.80:55433"); // query 剥离
    expect(instanceKey("garbage")).toBeNull();
  });
});

describe("RELAY-RESTORE-TARGET-09R:docker inspect 绑定严格解析(物理执行目标绑定)", () => {
  const inspectJson = (over: Record<string, unknown> = {}): string =>
    JSON.stringify([
      {
        Id: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        State: { Running: true },
        NetworkSettings: {
          Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55433" }] },
          ...(over as object),
        },
        ...(over as object),
      },
    ]);

  it("合法形态:运行中 + 5432/tcp 恰一条 127.0.0.1 映射 ⇒ 通过并返回发布端口", () => {
    expect(readInspectMapping(inspectJson(), "rst")).toEqual({
      hostPort: "55433",
      containerId: expect.stringMatching(/^abcdef/),
    });
  });

  it("非 JSON/容器数≠1/未运行/映射数≠1/HostIp≠127.0.0.1/端口非数字 ⇒ 一律拒绝且消息含实际值", () => {
    expect(() => readInspectMapping("not-json", "rst")).toThrow(/非 JSON/);
    expect(() => readInspectMapping("[]", "rst")).toThrow(/容器数=0/);
    expect(() =>
      readInspectMapping(
        JSON.stringify([
          {
            Id: "x",
            State: { Running: false },
            NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "1" }] } },
          },
        ]),
        "rst",
      ),
    ).toThrow(/未运行/);
    expect(() => readInspectMapping(inspectJson({ Ports: { "5432/tcp": [] } }), "rst")).toThrow(/恰一条/);
    expect(() =>
      readInspectMapping(inspectJson({ Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "55433" }] } }), "rst"),
    ).toThrow(/127\.0\.0\.1/);
    expect(() =>
      readInspectMapping(inspectJson({ Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "abc" }] } }), "rst"),
    ).toThrow(/非数字/);
  });
});

describe("RELAY-RESTORE-TARGET-09R:verifyRestoreTarget 总校验(pg 桩注入,零网络)", () => {
  const TS_A = "2026-11-15 09:00:00.000000+00";
  const TS_B = "2026-11-15 10:00:00.000000+00";

  it("① 文本快速门:同实例别名(R1/R3 形态)⇒ 拒绝且零探针连接", async () => {
    const { pgModule, calls } = stubPg({ startTime: TS_A, port: 55433 });
    const r = await verifyRestoreTarget(
      { sourceUrl: "postgresql://demo@127.0.0.1:55433/relayp000", targetUrl: "postgresql://demo@localhost:55433" },
      pgModule,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("规范化实例键相同");
    expect(r.reason).toContain("别名不构成隔离证明");
    expect(calls()).toBe(0); // 快速门在任何连接之前
  });

  it("③ 真值层:实例键不同但服务端身份相同(任意别名指向同一物理实例)⇒ 探针识别并拒绝", async () => {
    const { pgModule } = stubPg({ startTime: TS_A, port: 55433 }, { startTime: TS_A, port: 55433 });
    const r = await verifyRestoreTarget(
      {
        sourceUrl: "postgresql://demo@pg-a.internal.example:55433/relayp000",
        targetUrl: "postgresql://demo@pg-b.internal.example:55433",
      },
      pgModule,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("同一物理实例");
  });

  it("③ 真值层:源或目标身份不可证(探针失败)⇒ 拒绝(无从证明即保守拒绝)", async () => {
    const { pgModule } = stubPg(new Error("ECONNREFUSED"), { startTime: TS_B, port: 5432 });
    const r1 = await verifyRestoreTarget(
      { sourceUrl: "postgresql://demo@10.0.0.1:5432/relayp000", targetUrl: "postgresql://demo@10.0.0.2:5432" },
      pgModule,
    );
    expect(r1.ok).toBe(false);
    expect(r1.reason).toContain("源实例身份不可证");
    const { pgModule: pg2 } = stubPg({ startTime: TS_A, port: 5432 }, new Error("ECONNREFUSED"));
    const r2 = await verifyRestoreTarget(
      { sourceUrl: "postgresql://demo@10.0.0.1:5432/relayp000", targetUrl: "postgresql://demo@10.0.0.2:5432" },
      pg2,
    );
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain("恢复目标实例身份不可证");
  });

  it("③ 正例:不同实例(身份不同)⇒ 通过并返回双探针身份", async () => {
    const { pgModule } = stubPg({ startTime: TS_A, port: 55433 }, { startTime: TS_B, port: 5432 });
    const r = await verifyRestoreTarget(
      { sourceUrl: "postgresql://demo@10.0.0.1:55433/relayp000", targetUrl: "postgresql://demo@10.0.0.2:5432" },
      pgModule,
    );
    expect(r.ok).toBe(true);
    expect(r.source?.startTime).toBe(TS_A);
    expect(r.target?.startTime).toBe(TS_B);
  });

  it("② docker 绑定:RESTORE_URL 非回环 ⇒ 拒绝(声明目标无法与本地容器绑定)", async () => {
    const { pgModule, calls } = stubPg({ startTime: TS_A, port: 5432 });
    const r = await verifyRestoreTarget(
      {
        sourceUrl: "postgresql://demo@10.0.0.1:55433/relayp000",
        targetUrl: "postgresql://demo@10.30.5.80:55433",
        restoreContainer: "rst",
        containerInspectJson: JSON.stringify([
          {
            Id: "x",
            State: { Running: true },
            NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55433" }] } },
          },
        ]),
      },
      pgModule,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("回环");
    expect(calls()).toBe(0); // 绑定先于探针
  });

  it("② docker 绑定:发布端口≠RESTORE_URL 端口(R4 形态:声明目标≠实际容器)⇒ 拒绝;同名容器 ID(欺骗)⇒ 拒绝", async () => {
    const { pgModule, calls } = stubPg({ startTime: TS_A, port: 5432 });
    const r = await verifyRestoreTarget(
      {
        sourceUrl: "postgresql://demo@10.0.0.1:55433/relayp000",
        targetUrl: "postgresql://demo@127.0.0.1:59999",
        restoreContainer: "rst",
        containerInspectJson: JSON.stringify([
          {
            Id: "a".repeat(64),
            State: { Running: true },
            NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55433" }] } },
          },
        ]),
      },
      pgModule,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("发布端口");
    expect(calls()).toBe(0);

    const { pgModule: pg2 } = stubPg({ startTime: TS_A, port: 5432 });
    const sameId = JSON.stringify([
      {
        Id: "b".repeat(64),
        State: { Running: true },
        NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "59999" }] } },
      },
    ]);
    const r2 = await verifyRestoreTarget(
      {
        sourceUrl: "postgresql://demo@10.0.0.1:55433/relayp000",
        targetUrl: "postgresql://demo@127.0.0.1:59999",
        restoreContainer: "rst",
        containerInspectJson: sameId,
        sourceContainerInspectJson: sameId,
      },
      pg2,
    );
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain("同一容器 ID");
  });

  it("入参缺失:未提供 RELAY_DB_URL/RESTORE_URL ⇒ 拒绝(合同:无法提供源实例身份即拒绝)", async () => {
    const { pgModule } = stubPg({ startTime: TS_A, port: 5432 });
    const r1 = await verifyRestoreTarget({ targetUrl: "postgresql://demo@127.0.0.1:5432" }, pgModule);
    expect(r1.ok).toBe(false);
    expect(r1.reason).toContain("RELAY_DB_URL");
    const r2 = await verifyRestoreTarget({ sourceUrl: "postgresql://demo@10.0.0.1:5432/db" }, pgModule);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain("RESTORE_URL");
  });
});

// ── 动态 fail-closed(可控 PATH;假执行器;零真实 psql/docker/PG)────────────────────────────────
describe("RELAY-RESTORE-TARGET-09R:动态拒绝矩阵(可控 PATH,危险调用计数=0)", () => {
  const BIN_NEEDED = [
    "bash",
    "node",
    "dirname",
    "date",
    "ls",
    "wc",
    "sha256sum",
    "find",
    "head",
    "cat",
    "sort",
    "mktemp",
    "sed",
    "tr",
    "rm",
    "mkdir",
    "env",
    "grep",
  ];
  let root = "";

  /** 合成备份目录(完整性五项唯一 + 校验和;纯文件,零真实数据)。 */
  const mkBackup = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    const stamp = "20260101T000000Z";
    writeFileSync(join(dir, `backup-${stamp}.done`), `backup-complete\nstamp=${stamp}\nschema=p01a_red\n`);
    writeFileSync(join(dir, `db-${stamp}.sql`), "\\connect p01a_red\nCREATE TABLE p01a_red.t (id int);\n");
    writeFileSync(join(dir, `artifacts-manifest-${stamp}.json`), `{"targetSchema":"p01a_red","delivered":[]}\n`);
    writeFileSync(join(dir, `audit-index-${stamp}.txt`), "1|2026-01-01T00:00:00Z|red|RED_LINE\n");
    execFileSync("bash", [
      "-c",
      `cd "${dir}" && sha256sum "db-${stamp}.sql" "artifacts-manifest-${stamp}.json" "audit-index-${stamp}.txt" "backup-${stamp}.done" > "checksums-${stamp}.sha256"`,
    ]);
  };

  const buildPath = (mode: "host" | "docker"): string => {
    const bin = join(root, `bin-${mode}`);
    mkdirSync(bin, { recursive: true });
    for (const b of BIN_NEEDED) {
      const resolved = execFileSync("bash", ["-c", `command -v ${b}`], { encoding: "utf8" }).trim();
      symlinkSync(resolved, join(bin, b));
    }
    const fakePsql = `#!/usr/bin/env bash
printf 'psql %s\\n' "$*" >> "\${FAKE_LOG:?}"; exit "\${FAKE_EXIT:-79}"
`;
    const fakeDocker = `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "\${FAKE_LOG:?}"
case "$1" in
  inspect) [ -n "\${FAKE_INSPECT_JSON:-}" ] && cat "\${FAKE_INSPECT_JSON}" && exit 0 ;;
  exec) [ -n "\${FAKE_EXEC_TS:-}" ] && printf '%s\\n' "\${FAKE_EXEC_TS}" && exit 0 ;;
esac
exit "\${FAKE_EXIT:-79}"
`;
    if (mode === "host") {
      writeFileSync(join(bin, "psql"), fakePsql); // 宿主分支:假 psql
    } else {
      writeFileSync(join(bin, "docker"), fakeDocker); // docker 分支:假 docker(无 psql)
    }
    chmodSync(join(bin, mode === "host" ? "psql" : "docker"), 0o755);
    return bin;
  };

  /** 在封闭 PATH 下运行修后 restore-verify.sh;返回 exit/out;FAKE_LOG 记录假执行器 argv。 */
  const runScript = (
    bin: string,
    backupDir: string,
    restoreUrl: string,
    env: Record<string, string>,
  ): { status: number; out: string; argv: string } => {
    const logFile = join(root, `argv-${Math.random().toString(36).slice(2)}.log`);
    let status = 0;
    let out = "";
    try {
      out = execFileSync("bash", [join(deployDir, "restore-verify.sh"), backupDir, restoreUrl], {
        cwd: REPO,
        encoding: "utf8",
        timeout: 60_000,
        env: { PATH: bin, HOME: process.env.HOME ?? "", FAKE_LOG: logFile, ...env },
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      status = err.status ?? -1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    // 零调用 ⇒ 假执行器从未创建日志文件 ⇒ 记空(计数=0 断言依据)
    let argv = "";
    try {
      argv = readFileSync(logFile, "utf8");
    } catch {
      argv = "";
    }
    return { status, out, argv };
  };

  // 惰性初始化(两分支各一套 bin + 共用合成备份目录)
  const ensureRoot = (): void => {
    if (root) return;
    root = mkdtempSync(join(tmpdir(), "d09r-unit-"));
    mkBackup(join(root, "bk-valid"));
    buildPath("host");
    buildPath("docker");
  };

  it("宿主分支:同实例别名(R1 形态)⇒ 快速门拒绝,psql 调用次数=0", () => {
    ensureRoot();
    const r = runScript(join(root, "bin-host"), join(root, "bk-valid"), "postgresql://demo@localhost:55433", {
      RELAY_RESTORE_ISOLATED: "1",
      RELAY_DB_URL: "postgresql://demo@127.0.0.1:55433/relayp000",
    });
    expect(r.status, r.out.slice(0, 400)).not.toBe(0);
    expect(r.out).toContain("规范化实例键相同");
    expect(r.argv).toBe(""); // 零 DDL:psql 从未被调用
  });

  it("宿主分支:端口缺省别名(R3 形态)⇒ 拒绝且零调用", () => {
    ensureRoot();
    const r = runScript(join(root, "bin-host"), join(root, "bk-valid"), "postgresql://demo@localhost", {
      RELAY_RESTORE_ISOLATED: "1",
      RELAY_DB_URL: "postgresql://demo@127.0.0.1:5432/relayp000",
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("规范化实例键相同");
    expect(r.argv).toBe("");
  });

  it("宿主分支:字面同串(前缀形态)⇒ 保留 09 前缀层拒绝且零调用", () => {
    ensureRoot();
    const r = runScript(join(root, "bin-host"), join(root, "bk-valid"), "postgresql://postgres:pw@127.0.0.1:55433", {
      RELAY_RESTORE_ISOLATED: "1",
      RELAY_DB_URL: "postgresql://postgres:pw@127.0.0.1:55433/relayp000",
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("实例前缀");
    expect(r.argv).toBe("");
  });

  it("无法提供源实例身份(RELAY_DB_URL 缺失)⇒ fail-closed 且零 DDL(红态实测:旧脚本 [ -n 含 :-默认值 ] 短路静默跳过守卫照发 DROP argv——比崩溃更危险;Reviewer M3 独立实证)", () => {
    ensureRoot();
    const r = runScript(join(root, "bin-host"), join(root, "bk-valid"), "postgresql://demo@127.0.0.1:55433", {
      RELAY_RESTORE_ISOLATED: "1",
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("未提供 RELAY_DB_URL");
    expect(r.argv).toBe("");
  });

  it("宿主分支:源实例身份不可证(不可达端口)⇒ 拒绝且零 DDL(真值层保守拒绝)", () => {
    ensureRoot();
    const r = runScript(join(root, "bin-host"), join(root, "bk-valid"), "postgresql://demo@127.0.0.1:59998", {
      RELAY_RESTORE_ISOLATED: "1",
      RELAY_DB_URL: "postgresql://demo@127.0.0.1:1/none",
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("源实例身份不可证");
    expect(r.argv).toBe("");
  });

  it("docker 分支:假 docker inspect 失败(R2 形态:恢复容器不可绑定)⇒ 拒绝,DROP/CREATE 调用=0", () => {
    ensureRoot();
    const r = runScript(
      join(root, "bin-docker"),
      join(root, "bk-valid"),
      "postgresql://demo@invalid-target.invalid:55433",
      {
        RELAY_RESTORE_ISOLATED: "1",
        RELAY_RESTORE_CONTAINER: "relay-p000-pg",
        RELAY_DB_URL: "postgresql://demo@127.0.0.1:55433/relayp000",
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("docker inspect 恢复容器失败");
    expect(r.argv.split("\n").filter((l) => /DROP DATABASE|CREATE DATABASE/.test(l))).toEqual([]); // 只有 inspect 被记录
  });

  it("docker 分支:inspect 报发布端口与 RESTORE_URL 不一致(R4 形态)⇒ 拒绝且零 exec 调用", () => {
    ensureRoot();
    const inspect = join(root, "inspect-mismatch.json");
    writeFileSync(
      inspect,
      JSON.stringify([
        {
          Id: "c".repeat(64),
          State: { Running: true },
          NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "59997" }] } },
        },
      ]),
    );
    const r = runScript(join(root, "bin-docker"), join(root, "bk-valid"), "postgresql://demo@127.0.0.1:55433", {
      RELAY_RESTORE_ISOLATED: "1",
      RELAY_RESTORE_CONTAINER: "rst-container",
      RELAY_DB_URL: "postgresql://demo@127.0.0.1:55434/relayp000",
      FAKE_INSPECT_JSON: inspect,
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("发布端口");
    expect(r.argv.split("\n").filter((l) => l.includes(" exec "))).toEqual([]); // 无任何 exec(含只读探针)
  });

  it("docker 分支:RESTORE_URL 非回环 ⇒ 拒绝(本地容器无法绑定非回环声明)", () => {
    ensureRoot();
    const inspect = join(root, "inspect-nonloopback.json");
    writeFileSync(
      inspect,
      JSON.stringify([
        {
          Id: "d".repeat(64),
          State: { Running: true },
          NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55433" }] } },
        },
      ]),
    );
    const r = runScript(join(root, "bin-docker"), join(root, "bk-valid"), "postgresql://demo@10.30.5.80:55433", {
      RELAY_RESTORE_ISOLATED: "1",
      RELAY_RESTORE_CONTAINER: "rst-container",
      RELAY_DB_URL: "postgresql://demo@127.0.0.1:55434/relayp000",
      FAKE_INSPECT_JSON: inspect,
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("回环");
  });

  it("docker 分支:RELAY_RESTORE_CONTAINER 与显式源容器同名(容器名欺骗)⇒ DDL 前拒绝", () => {
    ensureRoot();
    const r = runScript(join(root, "bin-docker"), join(root, "bk-valid"), "postgresql://demo@127.0.0.1:59996", {
      RELAY_RESTORE_ISOLATED: "1",
      RELAY_RESTORE_CONTAINER: "relay-p000-pg",
      RELAY_PG_CONTAINER: "relay-p000-pg",
      RELAY_DB_URL: "postgresql://demo@127.0.0.1:55433/relayp000",
      FAKE_INSPECT_JSON: join(root, "bk-valid", "backup-20260101T000000Z.done"), // 占位:不应被读到(同名先拒)
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("容器名欺骗");
    expect(r.argv.split("\n").filter((l) => /DROP DATABASE|CREATE DATABASE/.test(l))).toEqual([]);
  });

  it("备份目录缺完成标记 ⇒ 拒绝先于身份探针(09 语义不退化)", () => {
    ensureRoot();
    const partial = join(root, "partial");
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, "db-20260101T000000Z.sql"), "x");
    const r = runScript(join(root, "bin-host"), partial, "postgresql://demo@127.0.0.1:55433", {
      RELAY_RESTORE_ISOLATED: "1",
      RELAY_DB_URL: "postgresql://demo@127.0.0.1:55434/relayp000",
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("完成标记");
    expect(r.argv).toBe("");
  });
});
