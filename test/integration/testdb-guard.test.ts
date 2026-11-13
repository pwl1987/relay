// RELAY-SAFETY-CLOSE-02 P0-C:测试库授权守卫故障注入(反例先行思路:证明错误生产 URL
// 在任何连接/写操作之前被拒绝;密码零打印;可达但未授权目标零写入)。
// 全部使用假 URL 与本容器默认管理员面(test-db-up.sh 已知测试凭据,非生产凭据);零生产触碰。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { assertAuthorizedTestDatabaseUrl, createTestDb, databaseUrl, redactDbUrl } from "../setup/testdb.ts";

const FAKE_PROD_URL = "postgresql://relay_prod_user:s3cret-prod-pw@db.production.example.com:5432/relay_prod";
// 可达但未授权:同一测试容器实例的管理库 postgres(能连通;守卫必须在连接前拒绝)
const REACHABLE_WRONG_DB_URL = "postgresql://postgres:relayp000local@127.0.0.1:55433/postgres";
const SECRET_MARK = "s3cret-prod-pw";

describe("RELAY-SAFETY-CLOSE-02 P0-C:测试库授权守卫(故障注入;零生产触碰)", () => {
  let savedUrl: string | undefined;
  beforeAll(() => {
    savedUrl = process.env.RELAY_DB_URL;
  });
  afterAll(() => {
    if (savedUrl === undefined) delete process.env.RELAY_DB_URL;
    else process.env.RELAY_DB_URL = savedUrl;
  });

  it("守卫单元:授权三元组通过;host/port/database 逐项错误全部拒绝(同步抛错,无 IO)", () => {
    expect(() => assertAuthorizedTestDatabaseUrl("postgresql://postgres:pw@127.0.0.1:55433/relayp000")).not.toThrow();
    expect(() => assertAuthorizedTestDatabaseUrl("postgresql://postgres:pw@localhost:55433/relayp000")).not.toThrow();
    // 非环回 host(典型生产形态)拒绝
    expect(() => assertAuthorizedTestDatabaseUrl("postgresql://u:p@10.30.5.80:5432/relay_prod")).toThrow(
      /测试库守卫拒绝/,
    );
    // 端口错误拒绝
    expect(() => assertAuthorizedTestDatabaseUrl("postgresql://u:p@127.0.0.1:5432/relayp000")).toThrow(
      /测试库守卫拒绝/,
    );
    // database 错误拒绝(可达与否不影响判定 —— 端口可达 ≠ 授权)
    expect(() => assertAuthorizedTestDatabaseUrl("postgresql://u:p@127.0.0.1:55433/relay_console")).toThrow(
      /测试库守卫拒绝/,
    );
    // 非法 URL 拒绝
    expect(() => assertAuthorizedTestDatabaseUrl("not-a-url")).toThrow(/测试库守卫拒绝/);
  });

  it("故障注入:假生产 RELAY_DB_URL ⇒ createTestDb 在任何连接之前拒绝(守卫错误,而非连接错误)", async () => {
    process.env.RELAY_DB_URL = FAKE_PROD_URL;
    let message = "";
    try {
      await createTestDb("p0c-fake-prod");
      expect.unreachable("守卫缺失:假生产 URL 竟然进入了连接流程");
    } catch (err) {
      message = (err as Error).message;
    }
    // 守卫语义(非连接层 ENOTFOUND/DIAL 错误)= 拒绝发生在连接之前
    expect(message).toContain("测试库守卫拒绝");
    expect(message).toContain("未执行任何连接或写操作");
    // 密码零打印(P0-C:连接串脱敏)
    expect(message).not.toContain(SECRET_MARK);
    expect(message).toContain("***");
  });

  it("故障注入:可达但未授权目标(同容器 postgres 管理库)⇒ 拒绝;且该库零 p01a_ schema(零写入机器证据)", async () => {
    process.env.RELAY_DB_URL = REACHABLE_WRONG_DB_URL;
    let message = "";
    try {
      await createTestDb("p0c-wrong-db");
      expect.unreachable("守卫缺失:未授权 database 竟然进入了 CREATE SCHEMA 流程");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("测试库守卫拒绝");
    expect(message).not.toContain("relayp000local"); // 测试凭据同样零打印
    // 零写入证明:postgres 数据库内不存在任何 p01a_ schema(若守卫缺失,CREATE SCHEMA 已发生)
    const probe = new pg.Pool({ connectionString: REACHABLE_WRONG_DB_URL, max: 1 });
    try {
      const r = await probe.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'p01a_%'");
      expect(Number(r.rows[0]!["n"])).toBe(0);
    } finally {
      await probe.end().catch(() => {});
    }
  });

  it("redactDbUrl:密码脱敏、无密码 URL 原样、非法输入安全占位", () => {
    expect(redactDbUrl(FAKE_PROD_URL)).not.toContain(SECRET_MARK);
    expect(redactDbUrl(FAKE_PROD_URL)).toContain("***");
    expect(redactDbUrl("postgresql://postgres@127.0.0.1:55433/relayp000")).toBe(
      "postgresql://postgres@127.0.0.1:55433/relayp000",
    );
    expect(redactDbUrl("::::")).toBe("(unparseable-db-url)");
  });

  it("干净环境默认 URL 经守卫放行(既有复现路径不受影响;守卫只拦未授权面)", async () => {
    delete process.env.RELAY_DB_URL;
    expect(() => assertAuthorizedTestDatabaseUrl(databaseUrl())).not.toThrow();
  });
});
