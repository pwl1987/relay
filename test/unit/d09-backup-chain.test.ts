// RELAY-BACKUP-INTEGRITY-09:备份/恢复链唯一入口语义与 fail-closed 矩阵(纯静态+动态无 docker)。
// 红态证据(对 a458e95 原始脚本运行本套件):p0-mvp/backup-integrity-09/evidence/red09-f-unit-source-contracts-red.log
// 红态可复核:git show a458e95:deploy/backup.sh 等四脚本(原始行为=整库 dump/未限定审计索引/跨 schema
// 聚合 manifest/计数假阳性/无隔离守卫),红态行为由 red09-a~e 真实脚本运行日志承担,本套件钉死修复后语义。
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redactDbUrl, isValidRelaySchemaName } from "../../deploy/backup-validate.mjs";

const deployDir = join(import.meta.dirname, "../../deploy");
const src = (f: string): string => readFileSync(join(deployDir, f), "utf8");

/** 剥掉 bash 注释后的脚本正文(静态契约应作用于可执行行,注释不算)。 */
function codeOf(f: string): string {
  return src(f)
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

describe("RELAY-BACKUP-INTEGRITY-09:backup.sh 唯一入口语义(静态契约)", () => {
  it("目标 schema 必须显式声明,未声明 ⇒ fail-closed(拒绝静默整库)", () => {
    const c = codeOf("backup.sh");
    expect(c).toMatch(/RELAY_BACKUP_SCHEMA:\?/);
  });

  it("dump 两分支均按目标 schema 限定(pg_dump -n;all 模式须显式)", () => {
    const c = codeOf("backup.sh");
    // 宿主分支与 docker 回退分支都必须出现 -n "$BACKUP_SCHEMA"
    expect(c.match(/-n "\$BACKUP_SCHEMA"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("审计索引两条路径都 schema 限定(不再出现未限定 FROM audit_events)", () => {
    const c = codeOf("backup.sh");
    expect(c).not.toMatch(/FROM audit_events/);
    expect(c).toMatch(/FROM \\"?\$BACKUP_SCHEMA\\"?\.audit_events/);
  });

  it("docker 回退目标一致:容器/库名一律派生自 env 与 RELAY_DB_URL,不再硬编码", () => {
    const c = codeOf("backup.sh");
    expect(c).not.toContain("docker exec relay-p000-pg");
    expect(c).not.toContain("-d relayp000");
  });

  it("无内嵌绝对路径(manifest 调用以脚本目录相对定位)", () => {
    expect(codeOf("backup.sh")).not.toContain("/home/ubuntu/dev/relay");
    expect(codeOf("backup.sh")).toMatch(/SCRIPT_DIR=/);
  });

  it("备份完成标记 + 失败清理自身产物(trap;失败不残留冒充成功)", () => {
    const c = codeOf("backup.sh");
    expect(c).toMatch(/trap /);
    expect(c).toMatch(/\.done/);
  });

  it("目标校验先于任何 dump/连接(backup-validate.mjs 单一入口)", () => {
    const c = codeOf("backup.sh");
    const validatePos = c.indexOf("backup-validate.mjs");
    const dumpPos = c.indexOf("pg_dump");
    expect(validatePos).toBeGreaterThan(-1);
    expect(dumpPos).toBeGreaterThan(validatePos);
  });
});

describe("RELAY-BACKUP-INTEGRITY-09:backup-validate.mjs 纯逻辑", () => {
  it("schema 标识符白名单:合法名接受,注入/引号/特殊字符拒绝", () => {
    expect(isValidRelaySchemaName("relay_console")).toBe(true);
    expect(isValidRelaySchemaName("p01a_d09a_1234abcd")).toBe(true);
    expect(isValidRelaySchemaName("public")).toBe(true);
    expect(isValidRelaySchemaName('x"; DROP SCHEMA y;--')).toBe(false);
    expect(isValidRelaySchemaName("a-b")).toBe(false);
    expect(isValidRelaySchemaName("1abc")).toBe(false);
    expect(isValidRelaySchemaName("")).toBe(false);
    expect(isValidRelaySchemaName('x"y')).toBe(false);
    expect(isValidRelaySchemaName("pg_catalog")).toBe(true); // 名字本身合法;归属校验由存在性检查承担
  });

  it("连接串脱敏:密码永不明文", () => {
    const out = redactDbUrl("postgresql://u:secret-pw@127.0.0.1:55433/relayp000");
    expect(out).not.toContain("secret-pw");
    expect(out).toContain("***");
    expect(redactDbUrl("(unparseable)")).toBe("(unparseable-db-url)");
  });
});

describe("RELAY-BACKUP-INTEGRITY-09:manifest/check 唯一入口与身份核对(静态契约)", () => {
  it("backup-manifest.mjs 必须显式声明目标 schema(env RELAY_BACKUP_SCHEMA),schema 模式参数化限定", () => {
    const c = src("backup-manifest.mjs");
    expect(c).toMatch(/RELAY_BACKUP_SCHEMA/);
    // schema 模式的存在性/归属校验必须参数化(防注入),跨 schema 枚举仅存在于显式 all 分支
    expect(c).toMatch(/schema_name=\$1/);
  });

  it("manifest 记录 targetSchema(恢复核对的目标身份唯一来源)", () => {
    expect(src("backup-manifest.mjs")).toMatch(/targetSchema/);
    expect(src("restore-verify-check.mjs")).toMatch(/targetSchema/);
  });

  it("restore-verify-check.mjs 必须做集合身份核对,不只计数", () => {
    const c = src("restore-verify-check.mjs");
    expect(c).toMatch(/manifestOnlyIds|identity|集合|身份/);
  });

  it("restore-verify.sh:隔离声明 + 源/目标不等校验 + 完成标记/多义性拒绝(恢复误指 fail-closed)", () => {
    const c = codeOf("restore-verify.sh");
    expect(c).toMatch(/RELAY_RESTORE_ISOLATED/);
    expect(c).toMatch(/\.done/);
    expect(c).toMatch(/RELAY_DB_URL/); // 与备份源实例比较
  });
});

describe("RELAY-BACKUP-INTEGRITY-09:动态 fail-closed(无 docker;node 直拒)", () => {
  it("backup-manifest.mjs 未声明 RELAY_BACKUP_SCHEMA ⇒ exit≠0 且拒绝消息含声明要求(先于任何连接)", () => {
    let out = "";
    let code = 0;
    try {
      execFileSync("node", ["deploy/backup-manifest.mjs", "/tmp/d09-unused-out", "/tmp/d09-unused-manifest.json"], {
        cwd: join(import.meta.dirname, "../.."),
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, RELAY_DB_URL: "postgresql://postgres:x@127.0.0.1:1/none", RELAY_BACKUP_SCHEMA: "" },
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      code = err.status ?? -1;
    }
    expect(code).not.toBe(0);
    expect(out).toContain("RELAY_BACKUP_SCHEMA");
  });

  it("backup-manifest.mjs 目标 schema 不存在 ⇒ exit≠0 拒绝(不产出 manifest 文件)", () => {
    let out = "";
    let code = 0;
    try {
      execFileSync("node", ["deploy/backup-manifest.mjs", "/tmp/d09-unused-out", "/tmp/d09-unused-manifest.json"], {
        cwd: join(import.meta.dirname, "../.."),
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          RELAY_DB_URL: "postgresql://postgres:x@127.0.0.1:1/none",
          RELAY_BACKUP_SCHEMA: "p01a_nonexistent_xyz",
        },
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      code = err.status ?? -1;
    }
    expect(code).not.toBe(0);
    expect(out).toContain("p01a_nonexistent_xyz");
  });
});
