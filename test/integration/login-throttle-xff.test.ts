// REWORK 安全修复定向反例:登录限速/锁定键不得信任客户端任意 X-Forwarded-For。
// 当前无可信反代部署 ⇒ clientIp 一律以 socket remoteAddress 为准(app.ts clientIp)。
// 旧实现按 XFF 首段取键 ⇒ 攻击者每次轮换伪造 XFF 即得到全新限速键,锁定永不触发(暴力破解面);
// 新实现:伪造 XFF 轮换无法稀释失败计数 —— 同一 socket 连续失败达阈值 ⇒ 锁定,
// 且锁定后**正确口令**也不得绕过(键与请求头无关)。真实 HTTP 栈(127.0.0.1)端到端验证。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { Auth } from "../../src/server/auth.ts";
import { createRelayServer } from "../../src/server/app.ts";

const PASSWORD = "xff-throttle-pw";

describe("REWORK:登录限速键 = socket remoteAddress(伪造 X-Forwarded-For 不稀释失败计数)", () => {
  let t: TestDb;
  let server: ReturnType<typeof createRelayServer>["server"];
  let base = "";
  const roots: string[] = [];

  beforeAll(async () => {
    t = await createTestDb("xff-throttle");
    const scratch = mkdtempSync(join(tmpdir(), "xff-throttle-"));
    roots.push(scratch);
    const auth = new Auth({
      password: PASSWORD,
      sessionTtlMs: 3_600_000,
      operators: ["owner"],
      maxLoginFailures: 3, // 阈值=3:三次失败即锁定
      loginWindowMs: 60_000,
      lockoutMs: 60_000,
    });
    const handle = createRelayServer({
      db: t.db,
      auth,
      host: "127.0.0.1",
      port: 0,
      staticDir: join(process.cwd(), "web"),
    });
    server = handle.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    try {
      server?.close();
    } catch {
      /* 已关 */
    }
    for (const r of roots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* 尽力而为 */
      }
    }
    await t.cleanup();
  });

  async function login(password: string, xff?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (xff !== undefined) headers["x-forwarded-for"] = xff;
    const res = await fetch(base + "/api/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ password }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("反例:每次轮换伪造 XFF 无法稀释失败计数 ⇒ 第 3 次失败即锁定;锁定后正确口令也不得绕过", async () => {
    // 旧实现下:三次请求各持不同伪造 XFF ⇒ 三个不同限速键 ⇒ 全部 401 bad_password、永不锁定。
    // 新实现下:键恒为 127.0.0.1(socket)⇒ 失败计数连续累计。
    const r1 = await login("wrong-1", "9.9.9.1");
    expect(r1.status).toBe(401);
    expect(r1.body["error"]).toBe("bad_password");
    const r2 = await login("wrong-2", "9.9.9.2, 10.10.10.2");
    expect(r2.status).toBe(401);
    expect(r2.body["error"]).toBe("bad_password");
    const r3 = await login("wrong-3", "fe80::1");
    expect(r3.status).toBe(401);
    expect(r3.body["error"]).toBe("bad_password");
    // 第 4 次:换一个全新的伪造地址 ⇒ 仍被锁(键与 XFF 无关 = 修复面直接反证)
    const r4 = await login("wrong-4", "10.99.99.99");
    expect(r4.status).toBe(429);
    expect(r4.body["error"]).toBe("locked_out");
    // 锁定后**正确口令**(再换伪造地址)也不得绕过:限速钥匙不在客户端手里
    const r5 = await login(PASSWORD, "10.88.88.88");
    expect(r5.status).toBe(429);
    expect(r5.body["error"]).toBe("locked_out");
  });

  it("正链:干净 socket 状态下正确口令登录成功(限速不误伤正常登录;失败清零后可再登录)", () => {
    // 独立 Auth 实例 = 独立限速状态(同进程内不与上一用例的锁定态串扰)
    const auth = new Auth({
      password: PASSWORD,
      sessionTtlMs: 3_600_000,
      operators: ["owner"],
      maxLoginFailures: 3,
      loginWindowMs: 60_000,
      lockoutMs: 60_000,
    });
    // 经 API 路径再验一次需另一服务器;此处直接以同款入参面验证 login 语义:
    // 失败一次(伪造 XFF 与否不影响键)→ 正确口令成功 → 失败计数被清零。
    return (async () => {
      await expect(auth.login("wrong", "127.0.0.1")).rejects.toMatchObject({ code: "bad_password" });
      const ok = await auth.login(PASSWORD, "127.0.0.1");
      expect(ok.session.role).toBe("owner");
      // 清零后再失败不会立即锁定(键=remoteAddress 时同样成立;此处钉住清零语义)
      await expect(auth.login("wrong-again", "127.0.0.1")).rejects.toMatchObject({ code: "bad_password" });
      const ok2 = await auth.login(PASSWORD, "127.0.0.1");
      expect(ok2.session.role).toBe("owner");
    })();
  });
});
