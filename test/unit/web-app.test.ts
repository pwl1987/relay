// P0-02C R-1 处置:G-1 绑定面的拒绝/显式放行行为 + 拒绝事件落 audit_events。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { auditBindRejected, createRelayServer, ensureLoopbackBind, BindRejectedError } from "../../src/server/app.ts";
import { Auth } from "../../src/server/auth.ts";

const ENV = "RELAY_WEB_ALLOW_NON_LOOPBACK";

describe("P0-02C:G-1 监听面(R-1)", () => {
  let t: TestDb;
  const saved = process.env[ENV];
  beforeAll(async () => {
    t = await createTestDb("p02c-webapp");
  });
  afterAll(async () => {
    await t.cleanup();
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it("回环地址(127.0.0.1/::1/localhost)默认放行", () => {
    expect(() => ensureLoopbackBind("127.0.0.1")).not.toThrow();
    expect(() => ensureLoopbackBind("::1")).not.toThrow();
    expect(() => ensureLoopbackBind("localhost")).not.toThrow();
  });

  it("非回环地址无显式放行 ⇒ 拒绝(refuse_non_loopback_bind;createRelayServer 同样拒绝)", () => {
    delete process.env[ENV];
    expect(() => ensureLoopbackBind("0.0.0.0")).toThrowError(BindRejectedError);
    try {
      ensureLoopbackBind("0.0.0.0");
      expect.unreachable();
    } catch (err) {
      expect((err as BindRejectedError).host).toBe("0.0.0.0");
      expect((err as Error).message).toContain("refuse_non_loopback_bind");
    }
    expect(() =>
      createRelayServer({
        db: t.db,
        auth: new Auth({ password: "x", sessionTtlMs: 1000, operators: ["owner"], maxLoginFailures: 5, loginWindowMs: 1000, lockoutMs: 1000 }),
        host: "0.0.0.0",
        port: 0,
        staticDir: "/tmp",
      }),
    ).toThrowError(BindRejectedError);
  });

  it("RELAY_WEB_ALLOW_NON_LOOPBACK=1 ⇒ 非回环放行(显式;测后还原)", () => {
    process.env[ENV] = "1";
    expect(() => ensureLoopbackBind("0.0.0.0")).not.toThrow();
  });

  it("绑定拒绝落 audit_events(WEB_BIND_REJECTED,authority=OWNER)", async () => {
    await auditBindRejected(t.db, "0.0.0.0", "refuse_non_loopback_bind:测试注入");
    const rows = await t.db.execute(
      sql`SELECT actor, authority, action, detail FROM audit_events WHERE action = 'WEB_BIND_REJECTED' ORDER BY seq DESC LIMIT 1`,
    );
    const r = rows.rows[0];
    expect(r).toBeTruthy();
    expect(String(r!["authority"])).toBe("OWNER");
    expect(String(r!["actor"])).toBe("relay-web");
    const detail = r!["detail"] as Record<string, unknown>;
    expect(String(detail["host"])).toBe("0.0.0.0");
    expect(String(detail["note"])).toContain("非回环");
  });
});
